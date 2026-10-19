/**
 * Concurrent per-site catalog discovery for tools/list and prompts/list.
 *
 * A listing waits up to `siteDeadlineMs` (default 4s) for snapshots that are
 * already ready. The wait never aborts token, readiness, initialize,
 * notifications/initialized, tools/list, or prompts hops. Not-yet-ready sites
 * are omitted from that response (fail closed). The chain finishes in the
 * background; a successful snapshot is cached and may emit list_changed.
 *
 * Success snapshots use a minutes-scale TTL (default 10 min) with
 * stale-while-revalidate. Errors use a short negative TTL so a cold start
 * does not stampede every host. A denial is never cached as a grant.
 */

import { isCatalogDeadlineError } from "./catalog-signal.js";
import { emitIfCatalogAdvertisementChanged } from "./catalog-notify.js";
import { loadConfig } from "./config.js";
import { fromIdentity } from "./principal-key.js";

/** Listing wait. A site that is not ready by then is omitted from that list. */
export const DEFAULT_SITE_DEADLINE_MS = 4_000;

/** Successful catalog snapshot TTL (stale-while-revalidate after this). */
export const DEFAULT_CATALOG_TTL_MS = 600_000;

/** Negative TTL for a failed site walk (seconds-scale). */
export const DEFAULT_NEGATIVE_TTL_MS = 5_000;

/**
 * Concurrent site walks. Default is high enough that a 13-site estate
 * starts in one wave.
 */
export const DEFAULT_CATALOG_CONCURRENCY = 16;

/** Acceptance budget for a cold tools/list / prompts/list (DEV-1019). */
export const CATALOG_LIST_BUDGET_MS = 5_000;

export { CATALOG_DEADLINE_CODE, isCatalogDeadlineError } from "./catalog-signal.js";

/** @type {Map<string, {at: number, ttl: number, snapshot: SiteCatalogSnapshot}>} */
const cache = new Map();

/** @type {Map<string, Promise<SiteCatalogSnapshot>>} */
const inflight = new Map();

/** @type {Set<string>} */
const pendingLogged = new Set();

/**
 * @typedef {object} SiteCatalogSnapshot
 * @property {string} siteName
 * @property {string} principalKey
 * @property {boolean} ok
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
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve wait / TTL / concurrency from overrides, env, then config.
 *
 * @param {object} [overrides]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   siteDeadlineMs: number,
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
    siteDeadlineMs: readPositiveInt(
      overrides.siteDeadlineMs ?? env.MCP_CATALOG_SITE_DEADLINE_MS ?? file.siteDeadlineMs,
      DEFAULT_SITE_DEADLINE_MS,
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
 * Cache / session key for one principal. Stdio and unresolved identities
 * share the `local` bucket so a listing never mixes with a network principal.
 *
 * @param {object|null|undefined} identity
 * @returns {string}
 */
export function catalogPrincipalKey(identity) {
  if (!identity || identity.localOperator === true) return "local";
  try {
    return fromIdentity(identity).principalKey;
  } catch {
    return "unresolved";
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
  return `${site?._name ?? ""}\0${catalogPrincipalKey(identity)}`;
}

/**
 * Drop cached and in-flight catalogs (tests, config reload).
 *
 * @returns {void}
 */
export function clearSiteCatalogCache() {
  cache.clear();
  inflight.clear();
  pendingLogged.clear();
}

/**
 * Drop cached catalogs for a site after an MCP session expiry. A null
 * `principalKey` clears every principal for that site.
 *
 * @param {string} siteName
 * @param {string|null} [principalKey]
 * @returns {void}
 */
export function invalidateSiteCatalogsForSite(siteName, principalKey = null) {
  const prefix = `${siteName}\0`;
  for (const key of cache.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (principalKey !== null && !key.endsWith(`\0${principalKey}`)) continue;
    cache.delete(key);
  }
  for (const key of inflight.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (principalKey !== null && !key.endsWith(`\0${principalKey}`)) continue;
    inflight.delete(key);
  }
  for (const key of [...pendingLogged]) {
    if (!key.startsWith(prefix)) continue;
    if (principalKey !== null && !key.endsWith(`\0${principalKey}`)) continue;
    pendingLogged.delete(key);
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
  if (isCatalogDeadlineError(error)) return "deadline exceeded";
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
 * Wait for `promise` up to `waitMs` without cancelling it.
 *
 * @param {Promise<SiteCatalogSnapshot>} promise
 * @param {number} waitMs
 * @param {string} siteName
 * @param {string} principalKey
 * @param {string} key
 * @param {boolean} logPending
 * @returns {Promise<SiteCatalogSnapshot>}
 */
async function waitForSnapshot(promise, waitMs, siteName, principalKey, key, logPending) {
  if (waitMs <= 0) {
    return omittedSnapshot(siteName, principalKey, "not ready");
  }
  const result = await Promise.race([
    promise.then((snapshot) => ({ done: true, snapshot })),
    delay(waitMs).then(() => ({ done: false })),
  ]);
  if (result.done) return result.snapshot;
  if (logPending && !pendingLogged.has(key)) {
    pendingLogged.add(key);
    logOmittedSite(siteName, "not ready");
  }
  return omittedSnapshot(siteName, principalKey, "not ready");
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
  const previous = cache.get(key)?.snapshot;
  if (typeof work !== "function") {
    return omittedSnapshot(siteName, principalKey, "source error");
  }
  try {
    const loaded = await work(site);
    const snapshot = {
      siteName,
      principalKey,
      ok: true,
      reason: null,
      tools: loaded?.tools instanceof Map ? loaded.tools : new Map(),
      prompts: Array.isArray(loaded?.prompts) ? loaded.prompts : [],
      promptBodies: loaded?.promptBodies instanceof Map ? loaded.promptBodies : new Map(),
    };
    // A skip (nothing enabled, source never contacted) is not a catalog.
    if (loaded?.cache !== false) {
      cache.set(key, { at: Date.now(), ttl: settings.cacheTtlMs, snapshot });
      pendingLogged.delete(key);
      emitIfCatalogAdvertisementChanged(previous, snapshot);
    }
    return snapshot;
  } catch (error) {
    const reason = omitReasonFromError(error);
    logOmittedSite(siteName, reason);
    if (previous?.ok) {
      // Keep the last good snapshot. A failed refresh is not a grant and
      // must not hide a verified catalog.
      return previous;
    }
    const snapshot = omittedSnapshot(siteName, principalKey, reason);
    cache.set(key, { at: Date.now(), ttl: settings.negativeTtlMs, snapshot });
    pendingLogged.delete(key);
    emitIfCatalogAdvertisementChanged(previous, snapshot);
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
 * @param {(site: object) => Promise<{
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
 * @returns {Promise<SiteCatalogSnapshot>}
 */
export async function loadSiteCatalog(site, options = {}) {
  const identity = options.identity;
  const principalKey = catalogPrincipalKey(identity);
  const siteName = site?._name ?? "";
  const key = catalogCacheKey(site, identity);
  const settings = getCatalogDiscoveryOptions(options);
  const waitMs = Object.hasOwn(options, "waitMs")
    ? readNonNegativeInt(options.waitMs, settings.siteDeadlineMs)
    : settings.siteDeadlineMs;
  const logPending = options.logPending !== false;
  const cached = cache.get(key);
  if (cached) {
    const age = Date.now() - cached.at;
    if (cached.snapshot.ok) {
      if (age < cached.ttl) return cached.snapshot;
      startCatalogWork(site, options, key, siteName, principalKey, settings);
      return cached.snapshot;
    }
    if (age < cached.ttl) return cached.snapshot;
  }

  const pending = inflight.get(key);
  if (pending) {
    return waitForSnapshot(pending, waitMs, siteName, principalKey, key, logPending);
  }

  const promise = startCatalogWork(site, options, key, siteName, principalKey, settings);
  return waitForSnapshot(promise, waitMs, siteName, principalKey, key, logPending);
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
