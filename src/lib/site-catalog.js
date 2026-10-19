/**
 * Concurrent per-site catalog discovery for tools/list and prompts/list.
 *
 * A listing never aborts token, readiness, initialize,
 * notifications/initialized, tools/list, or prompt hops. When list_changed
 * can reach this session, the wait is `siteDeadlineMs` (default 4s): stdio
 * and legacy HTTP at 2025-11-25, or stdio 2026-07-28 after
 * `subscriptions/listen` on that connection (held until the Server is
 * registered). Modern HTTP 2026-07-28 cannot bind a listen to a
 * sessionless POST / per-request Server, so it always uses the unnotified
 * wait. That wait is `unnotifiedListWaitMs` (default 20s). The whole
 * listing — catalog wait plus the listing governance re-check — is
 * hard-capped at 25s, then the partial list. Governance is checked in
 * parallel under a 4s cap (not leftover unnotified budget per site).
 *
 * Order: source governance, then the Drupal handshake and `tools/list`
 * overlap prompt hops. `onTools` fires when `tools/list` returns. Prompt
 * hops do not wait for that handshake, and they do not open `/mcp` until
 * governance has resolved. Success snapshots use a
 * minutes-scale TTL (default 10 min) with stale-while-revalidate. Errors use
 * a short negative TTL. A denial is never cached as a grant.
 */

import { catalogShutdownSignal } from "./catalog-signal.js";
import { catalogChangeCanReachClient, emitIfCatalogAdvertisementChanged } from "./catalog-notify.js";
import { loadConfig } from "./config.js";
import { fromIdentity } from "./principal-key.js";

/** Listing wait when list_changed can reach the client. */
export const DEFAULT_SITE_DEADLINE_MS = 4_000;

/**
 * First-list wait when list_changed cannot reach the client. Well under a
 * typical 30s client timeout. Config/env values above
 * {@link MAX_LIST_WAIT_MS} are clamped so the whole listing (catalog wait
 * plus the listing governance re-check) stays inside that cap.
 */
export const DEFAULT_UNNOTIFIED_LIST_WAIT_MS = 20_000;

/**
 * Hard cap on the whole listing wait (notified or not): catalog wait plus
 * the listing governance re-check. Leaves headroom under a 30s client timeout.
 */
export const MAX_LIST_WAIT_MS = 25_000;

/** Successful catalog snapshot TTL (stale-while-revalidate after this). */
export const DEFAULT_CATALOG_TTL_MS = 600_000;

/** Negative TTL for a failed site walk (seconds-scale). */
export const DEFAULT_NEGATIVE_TTL_MS = 5_000;

/**
 * Concurrent site walks. Default is high enough that a 13-site estate
 * starts in one wave.
 */
export const DEFAULT_CATALOG_CONCURRENCY = 16;

/** Acceptance budget for a cold tools/list when list_changed can be delivered. */
export const CATALOG_LIST_BUDGET_MS = 5_000;

/** @type {Map<string, {at: number, ttl: number, snapshot: SiteCatalogSnapshot}>} */
const cache = new Map();

/** @type {Map<string, Promise<SiteCatalogSnapshot>>} */
const inflight = new Map();

/** @type {Map<string, Set<(snapshot: SiteCatalogSnapshot) => void>>} */
const cacheWaiters = new Map();

/** @type {Set<string>} */
const pendingLogged = new Set();

/** Bumped on full cache clear so a live walk cannot store after reset. */
let catalogEpoch = 0;

/**
 * @typedef {object} SiteCatalogSnapshot
 * @property {string} siteName
 * @property {string} principalKey
 * @property {boolean} ok
 * @property {boolean} complete
 * @property {string|null} reason
 * @property {Map<string, object>} tools
 * @property {object[]} prompts
 * @property {Map<string, object>} promptBodies
 */

/**
 * Empty fail-closed snapshot.
 *
 * @param {string} siteName
 * @param {string} principalKey
 * @param {string} reason
 * @returns {SiteCatalogSnapshot}
 */
function omittedSnapshot(siteName, principalKey, reason) {
  return {
    siteName,
    principalKey,
    ok: false,
    complete: false,
    reason,
    tools: new Map(),
    prompts: [],
    promptBodies: new Map(),
  };
}

/**
 * Parse a positive integer setting, or return the default.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function readPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Positive integer capped at {@link MAX_LIST_WAIT_MS}.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function readClampedWaitMs(value, fallback) {
  return Math.min(readPositiveInt(value, fallback), MAX_LIST_WAIT_MS);
}

/**
 * Non-negative integer (0 is a valid prefetch wait).
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function readNonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Resolve wait / TTL / concurrency from overrides, env, then config.
 *
 * @param {object} [overrides]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   siteDeadlineMs: number,
 *   unnotifiedListWaitMs: number,
 *   cacheTtlMs: number,
 *   negativeTtlMs: number,
 *   concurrency: number,
 * }}
 */
export function getCatalogDiscoveryOptions(overrides = {}, env = process.env) {
  let file = {};
  try {
    const block = loadConfig()?.catalogDiscovery;
    if (block && typeof block === "object" && !Array.isArray(block)) file = block;
  } catch {
    // Tests and single-site env fallback still get defaults.
  }
  return {
    siteDeadlineMs: readClampedWaitMs(
      overrides.siteDeadlineMs ?? env.MCP_CATALOG_SITE_DEADLINE_MS ?? file.siteDeadlineMs,
      DEFAULT_SITE_DEADLINE_MS,
    ),
    unnotifiedListWaitMs: readClampedWaitMs(
      overrides.unnotifiedListWaitMs ?? env.MCP_CATALOG_UNNOTIFIED_LIST_WAIT_MS ?? file.unnotifiedListWaitMs,
      DEFAULT_UNNOTIFIED_LIST_WAIT_MS,
    ),
    cacheTtlMs: readPositiveInt(
      overrides.cacheTtlMs ?? env.MCP_CATALOG_CACHE_TTL_MS ?? file.cacheTtlMs,
      DEFAULT_CATALOG_TTL_MS,
    ),
    negativeTtlMs: readPositiveInt(
      overrides.negativeTtlMs ?? env.MCP_CATALOG_NEGATIVE_TTL_MS ?? file.negativeTtlMs,
      DEFAULT_NEGATIVE_TTL_MS,
    ),
    concurrency: readPositiveInt(
      overrides.concurrency ?? env.MCP_CATALOG_CONCURRENCY ?? file.concurrency,
      DEFAULT_CATALOG_CONCURRENCY,
    ),
  };
}

/**
 * Listing wait for this session: 4s when list_changed can be delivered
 * to this session, otherwise the unnotified budget (default 20s, hard
 * cap {@link MAX_LIST_WAIT_MS} for the whole listing). The governance
 * phase is separate, parallel, and capped at 4s. Modern HTTP 2026
 * always takes the unnotified wait.
 *
 * @param {{getNegotiatedProtocolVersion?: Function}|null|undefined} [server]
 * @param {object} [overrides]
 * @returns {number}
 */
export function catalogListWaitMs(server, overrides = {}) {
  const settings = getCatalogDiscoveryOptions(overrides);
  const wait = catalogChangeCanReachClient(server)
    ? settings.siteDeadlineMs
    : settings.unnotifiedListWaitMs;
  return Math.min(wait, MAX_LIST_WAIT_MS);
}

/**
 * Remaining listing budget after catalog wait. Passed into the listing
 * governance helper, which then caps the phase at 4s in parallel — leftover
 * unnotified budget is not applied per site. `waitMs` 0 is valid (no
 * remaining budget). Omitted/`undefined` wait is unbounded (`undefined`).
 *
 * @param {number|undefined} waitMs
 * @param {number} startedAt
 * @returns {number|undefined}
 */
export function remainingCatalogListBudgetMs(waitMs, startedAt) {
  if (waitMs === undefined) return undefined;
  return Math.max(0, Math.min(MAX_LIST_WAIT_MS, Number(waitMs)) - (Date.now() - startedAt));
}

/**
 * Cache / session key for one principal. Stdio identities share the
 * `local` bucket so a listing never mixes with a network principal.
 * A malformed identity is uncacheable (`null`) and fail-closed.
 *
 * @param {object|null|undefined} identity
 * @returns {string|null}
 */
export function catalogPrincipalKey(identity) {
  if (!identity || identity.localOperator === true) return "local";
  try {
    return fromIdentity(identity).principalKey;
  } catch {
    return null;
  }
}

/**
 * Cache key for one (site, principal).
 *
 * @param {object} site
 * @param {object|null|undefined} identity
 * @returns {string}
 */
export function catalogCacheKey(site, identity) {
  const principalKey = catalogPrincipalKey(identity);
  if (principalKey === null) return null;
  return `${site?._name ?? ""}\0${principalKey}`;
}

/**
 * Drop cached and in-flight catalogs (tests, config reload).
 *
 * @returns {void}
 */
export function clearSiteCatalogCache() {
  catalogEpoch += 1;
  cache.clear();
  inflight.clear();
  cacheWaiters.clear();
  pendingLogged.clear();
}

/**
 * Drop cached catalogs for a site after an MCP session expiry. A null
 * `principalKey` clears every principal for that site. A live in-flight
 * walk is kept so a concurrent listing cannot start a second handshake;
 * orphaned waiters (no live walk) are dropped.
 *
 * @param {string} siteName
 * @param {string|null} [principalKey]
 * @returns {void}
 */
export function invalidateSiteCatalogsForSite(siteName, principalKey = null) {
  const matches = (key) => {
    const prefix = `${siteName}\0`;
    if (!key.startsWith(prefix)) return false;
    if (principalKey !== null && !key.endsWith(`\0${principalKey}`)) return false;
    return true;
  };
  for (const key of [...cache.keys()]) {
    if (matches(key)) cache.delete(key);
  }
  // Keep a live walk. Dropping inflight here lets the next listing start a
  // second handshake for the same key while runCatalogWork is still running.
  for (const key of [...cacheWaiters.keys()]) {
    if (!matches(key) || inflight.has(key)) continue;
    cacheWaiters.delete(key);
  }
  for (const key of [...pendingLogged]) {
    if (matches(key)) pendingLogged.delete(key);
  }
}

/**
 * Workflow ids locally enabled on a site (skip `_` comment keys).
 *
 * @param {object} site
 * @returns {string[]}
 */
export function workflowIdsFromSite(site) {
  const workflows = site?.serverTools?.modules?.workflows;
  if (!workflows || typeof workflows !== "object") return [];
  const ids = [];
  for (const [id, body] of Object.entries(workflows)) {
    if (id.startsWith("_") || !body || typeof body !== "object") continue;
    ids.push(typeof body.id === "string" && body.id ? body.id : id);
  }
  return ids;
}

/**
 * One stderr line for an omitted site. Reasons are stable codes — never
 * tokens, secrets, or raw source bodies.
 *
 * @param {string} siteName
 * @param {string} reason
 * @returns {void}
 */
export function logOmittedSite(siteName, reason) {
  console.error(`[drupal-mcp-connector] Catalog discovery omitted site "${siteName}": ${reason}`);
}

/**
 * Stable, non-secret omit reason for a failed site load.
 *
 * @param {*} error
 * @returns {string}
 */
function omitReasonFromError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "source error";
  if (typeof error?.reason === "string" && error.reason && !/secret|token|bearer|password/i.test(error.reason)) {
    return error.reason;
  }
  return "source error";
}

/**
 * Run `fn` over items with a concurrency cap. Results keep input order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapSitesBounded(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const limit = Math.max(1, Math.min(readPositiveInt(concurrency, 1), list.length));
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await fn(list[index], index);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

/**
 * @param {SiteCatalogSnapshot|null|undefined} snapshot
 * @param {"tools"|"complete"} until
 * @returns {boolean}
 */
function snapshotSatisfies(snapshot, until) {
  if (!snapshot?.ok) return false;
  return until === "complete" ? snapshot.complete === true : true;
}

/**
 * @param {string} key
 * @param {SiteCatalogSnapshot} snapshot
 * @returns {void}
 */
function notifyCacheWaiters(key, snapshot) {
  const waiters = cacheWaiters.get(key);
  if (!waiters) return;
  for (const waiter of [...waiters]) waiter(snapshot);
}

/**
 * Wait for `promise` up to `waitMs` without cancelling it. Resolves early
 * when a tools-ready (or complete) snapshot is cached.
 *
 * @param {Promise<SiteCatalogSnapshot>} promise
 * @param {number} waitMs
 * @param {string} siteName
 * @param {string} principalKey
 * @param {string} key
 * @param {boolean} logPending
 * @param {"tools"|"complete"} until
 * @returns {Promise<SiteCatalogSnapshot>}
 */
async function waitForSnapshot(promise, waitMs, siteName, principalKey, key, logPending, until) {
  const cached = cache.get(key)?.snapshot;
  if (snapshotSatisfies(cached, until)) return cached;
  if (waitMs <= 0) {
    return omittedSnapshot(siteName, principalKey, "not ready");
  }
  return await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (logPending && !pendingLogged.has(key)) {
        pendingLogged.add(key);
        logOmittedSite(siteName, "not ready");
      }
      finish(omittedSnapshot(siteName, principalKey, "not ready"));
    }, waitMs);
    if (typeof timer.unref === "function") timer.unref();
    const finish = (snapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const waiters = cacheWaiters.get(key);
      if (waiters) {
        waiters.delete(onCache);
        if (waiters.size === 0) cacheWaiters.delete(key);
      }
      resolve(snapshot);
    };
    const onCache = (snapshot) => {
      if (snapshotSatisfies(snapshot, until)) finish(snapshot);
    };
    const waiters = cacheWaiters.get(key) ?? new Set();
    waiters.add(onCache);
    cacheWaiters.set(key, waiters);
    const already = cache.get(key)?.snapshot;
    if (snapshotSatisfies(already, until)) {
      finish(already);
      return;
    }
    promise.then((snapshot) => finish(snapshot), () => {
      finish(omittedSnapshot(siteName, principalKey, "source error"));
    });
  });
}

/**
 * Store a snapshot and notify waiters.
 *
 * @param {string} key
 * @param {SiteCatalogSnapshot} snapshot
 * @param {number} ttl
 * @param {SiteCatalogSnapshot|undefined} previous
 * @returns {void}
 */
function storeSnapshot(key, snapshot, ttl, previous) {
  cache.set(key, { at: Date.now(), ttl, snapshot });
  pendingLogged.delete(key);
  emitIfCatalogAdvertisementChanged(previous, snapshot);
  notifyCacheWaiters(key, snapshot);
}

/**
 * Run site catalog work to completion. Never aborted by the listing wait.
 *
 * @param {object} site
 * @param {object} options
 * @param {string} key
 * @param {string} siteName
 * @param {string} principalKey
 * @param {{cacheTtlMs: number, negativeTtlMs: number}} settings
 * @returns {Promise<SiteCatalogSnapshot>}
 */
async function runCatalogWork(site, options, key, siteName, principalKey, settings) {
  const work = options.work;
  const epoch = catalogEpoch;
  const previous = cache.get(key)?.snapshot;
  if (typeof work !== "function") {
    return omittedSnapshot(siteName, principalKey, "source error");
  }
  if (catalogShutdownSignal().aborted) {
    return omittedSnapshot(siteName, principalKey, "source error");
  }
  try {
    const loaded = await work(site, {
      onTools(partial) {
        if (catalogShutdownSignal().aborted) return;
        const snapshot = {
          siteName,
          principalKey,
          ok: true,
          complete: partial?.complete === true,
          reason: null,
          tools: partial?.tools instanceof Map ? partial.tools : new Map(),
          prompts: Array.isArray(partial?.prompts) ? partial.prompts : (previous?.prompts ?? []),
          promptBodies: partial?.promptBodies instanceof Map
            ? partial.promptBodies
            : (previous?.promptBodies ?? new Map()),
        };
        if (epoch === catalogEpoch) {
          storeSnapshot(key, snapshot, settings.cacheTtlMs, previous);
        }
      },
    });
    if (catalogShutdownSignal().aborted) {
      return omittedSnapshot(siteName, principalKey, "source error");
    }
    const snapshot = {
      siteName,
      principalKey,
      ok: true,
      complete: true,
      reason: null,
      tools: loaded?.tools instanceof Map ? loaded.tools : new Map(),
      prompts: Array.isArray(loaded?.prompts) ? loaded.prompts : [],
      promptBodies: loaded?.promptBodies instanceof Map ? loaded.promptBodies : new Map(),
    };
    // A skip (nothing enabled, source never contacted) is not a catalog.
    if (loaded?.cache !== false && epoch === catalogEpoch) {
      storeSnapshot(key, snapshot, settings.cacheTtlMs, cache.get(key)?.snapshot ?? previous);
    }
    return snapshot;
  } catch (error) {
    const reason = omitReasonFromError(error);
    logOmittedSite(siteName, reason);
    const latest = cache.get(key)?.snapshot ?? previous;
    if (latest?.ok) {
      // Keep the last good snapshot, including a tools-ready partial if
      // prompt hops fail. A failed refresh is not a grant and must not
      // hide a verified catalog.
      return latest;
    }
    const snapshot = omittedSnapshot(siteName, principalKey, reason);
    if (epoch === catalogEpoch) {
      cache.set(key, { at: Date.now(), ttl: settings.negativeTtlMs, snapshot });
      pendingLogged.delete(key);
      emitIfCatalogAdvertisementChanged(previous, snapshot);
      notifyCacheWaiters(key, snapshot);
    }
    return snapshot;
  }
}

/**
 * Start work if none is in flight. The listing wait does not cancel it.
 *
 * @param {object} site
 * @param {object} options
 * @param {string} key
 * @param {string} siteName
 * @param {string} principalKey
 * @param {{cacheTtlMs: number, negativeTtlMs: number}} settings
 * @returns {Promise<SiteCatalogSnapshot>}
 */
function startCatalogWork(site, options, key, siteName, principalKey, settings) {
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = runCatalogWork(site, options, key, siteName, principalKey, settings);
  inflight.set(key, promise);
  promise.finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  return promise;
}

/**
 * Load one site's remote catalog. Concurrent callers share one in-flight
 * promise. The listing wait returns whatever is ready; work continues.
 *
 * @param {object} site
 * @param {object} [options]
 * @param {object|null} [options.identity]
 * @param {(site: object, hooks?: {onTools?: Function}) => Promise<{
 *   tools?: Map<string, object>,
 *   prompts?: object[],
 *   promptBodies?: Map<string, object>,
 *   cache?: boolean,
 * }>} [options.work]
 * @param {number} [options.siteDeadlineMs]
 * @param {number} [options.waitMs]
 * @param {number} [options.cacheTtlMs]
 * @param {number} [options.negativeTtlMs]
 * @param {boolean} [options.logPending]
 * @param {"tools"|"complete"} [options.waitUntil]
 * @returns {Promise<SiteCatalogSnapshot>}
 */
export async function loadSiteCatalog(site, options = {}) {
  const identity = options.identity;
  const principalKey = catalogPrincipalKey(identity);
  const siteName = site?._name ?? "";
  if (principalKey === null) {
    return omittedSnapshot(siteName, "malformed", "malformed identity");
  }
  const key = catalogCacheKey(site, identity);
  const settings = getCatalogDiscoveryOptions(options);
  const waitMs = Math.min(
    Object.hasOwn(options, "waitMs")
      ? readNonNegativeInt(options.waitMs, settings.siteDeadlineMs)
      : settings.siteDeadlineMs,
    MAX_LIST_WAIT_MS,
  );
  const until = options.waitUntil === "complete" ? "complete" : "tools";
  const logPending = options.logPending !== false;
  const cached = cache.get(key);
  if (cached) {
    const age = Date.now() - cached.at;
    if (cached.snapshot.ok) {
      if (age < cached.ttl && snapshotSatisfies(cached.snapshot, until)) {
        return cached.snapshot;
      }
      if (age < cached.ttl && until === "complete" && inflight.has(key)) {
        return waitForSnapshot(inflight.get(key), waitMs, siteName, principalKey, key, logPending, until);
      }
      if (age >= cached.ttl) {
        startCatalogWork(site, options, key, siteName, principalKey, settings);
        if (snapshotSatisfies(cached.snapshot, until)) return cached.snapshot;
      }
    } else if (age < cached.ttl) {
      return cached.snapshot;
    }
  }

  const pending = inflight.get(key);
  if (pending) {
    return waitForSnapshot(pending, waitMs, siteName, principalKey, key, logPending, until);
  }

  const promise = startCatalogWork(site, options, key, siteName, principalKey, settings);
  return waitForSnapshot(promise, waitMs, siteName, principalKey, key, logPending, until);
}

/**
 * Load catalogs for many sites concurrently (bounded). A slow site cannot
 * stall another: there is no global serial lock. The listing wait does not
 * abort any site's chain.
 *
 * @param {Array<object>} sites
 * @param {object} [options] Passed to {@link loadSiteCatalog} plus `concurrency`.
 * @returns {Promise<Map<string, SiteCatalogSnapshot>>}
 */
export async function loadSiteCatalogs(sites, options = {}) {
  const list = Array.isArray(sites) ? sites : [];
  const settings = getCatalogDiscoveryOptions(options);
  const snapshots = await mapSitesBounded(list, settings.concurrency, (site) => loadSiteCatalog(site, options));
  const result = new Map();
  snapshots.forEach((snapshot, index) => {
    const name = snapshot?.siteName || list[index]?._name;
    if (name) result.set(name, snapshot);
  });
  return result;
}

/**
 * Start catalog walks for resolvable sites without waiting. Used at process
 * start and on MCP initialize so the first tools/list is not the first walk.
 *
 * @param {Array<object>} sites
 * @param {object} [options]
 * @returns {void}
 */
export function prefetchSiteCatalogs(sites, options = {}) {
  void loadSiteCatalogs(sites, {
    ...options,
    waitMs: Object.hasOwn(options, "waitMs") ? options.waitMs : 0,
    logPending: options.logPending === true,
  }).catch(() => {});
}
