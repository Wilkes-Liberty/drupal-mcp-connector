/**
 * Readiness checks for the mesh-only ops listener (DEV-863).
 *
 * `/ready` probes real dependencies: auth / introspection reachability
 * (bounded timeout, 2xx + RFC 7662-shaped body) and config completeness
 * (hosted scope table plus entity / Host / Origin allowlists). Results
 * are cached for a few seconds and single-flighted so mesh peers cannot
 * amplify traffic to the identity provider. The 503 body names failing
 * checks only — never URLs, tokens, or other secrets.
 */

import { assertHostedToolScopeTable } from "./tool-scopes.js";
import { resolveSecurityConfig } from "./security.js";
import { resolveAllowedHosts, resolveAllowedOrigins } from "./http-transport.js";

const CHECK_INTROSPECTION = "introspection";
const CHECK_AUTH = "auth";
const CHECK_SCOPE_TABLE = "scope_table";
const CHECK_ALLOWLISTS = "allowlists";

/** Closed check names returned in a 503 body. */
export const READY_CHECK_NAMES = Object.freeze([
  CHECK_INTROSPECTION,
  CHECK_AUTH,
  CHECK_SCOPE_TABLE,
  CHECK_ALLOWLISTS,
]);

const DEFAULT_READY_TIMEOUT_MS = 2000;

/** How long a /ready probe result is reused (5–10s). */
export const READY_PROBE_CACHE_MS = 8000;

/**
 * Whether `value` is a well-formed entity allowlist (array of strings or null).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function allowlistFieldOk(value) {
  if (value === null) return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => typeof item === "string");
}

/**
 * RFC 7662 introspection body: a JSON object with a boolean `active`.
 *
 * @param {unknown} body
 * @returns {boolean}
 */
export function isIntrospectionBody(body) {
  return Boolean(
    body
    && typeof body === "object"
    && !Array.isArray(body)
    && typeof body.active === "boolean",
  );
}

/**
 * Whether an introspection probe response counts as reachable.
 * Only a 2xx status with a valid introspection-shaped body passes.
 * 401, 404, and 5xx are not ready.
 *
 * @param {number} status
 * @param {unknown} body
 * @returns {boolean}
 */
export function introspectionProbeOk(status, body) {
  if (!Number.isInteger(status) || status < 200 || status > 299) return false;
  return isIntrospectionBody(body);
}

/**
 * Hosted scope table covers every registered tool.
 *
 * @param {Array<{name: string}>} [definitions]
 * @returns {boolean}
 */
export function checkScopeTable(definitions = []) {
  try {
    assertHostedToolScopeTable(definitions);
    return true;
  } catch {
    return false;
  }
}

/**
 * Entity allowlists on each site plus the resolved Host / Origin lists
 * are well-formed. Does not serialize site names or allowlist contents.
 *
 * @param {object} [options]
 * @param {Array<object>} [options.sites]
 * @param {object} [options.inboundCfg]
 * @param {boolean} [options.loopbackBind]
 * @returns {boolean}
 */
export function checkAllowlists({
  sites = [],
  inboundCfg = {},
  loopbackBind = false,
} = {}) {
  try {
    for (const site of sites) {
      const security = resolveSecurityConfig(site);
      if (!allowlistFieldOk(security.allowedEntityTypes)) return false;
      if (!allowlistFieldOk(security.deniedEntityTypes ?? [])) return false;
    }
    resolveAllowedHosts({
      allowedHosts: inboundCfg.allowedHosts,
      resource: inboundCfg.resource,
      audience: inboundCfg.audience,
      loopbackBind,
    });
    resolveAllowedOrigins({
      allowedOrigins: inboundCfg.allowedOrigins,
      resource: inboundCfg.resource,
      audience: inboundCfg.audience,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe the introspection endpoint. Reachable only on 2xx plus a valid
 * RFC 7662 body. The URL and body never leave this function.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchFn]
 * @returns {Promise<boolean>}
 */
export async function checkIntrospectionReachable({
  url,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  fetchFn = fetch,
}) {
  if (typeof url !== "string" || !url) return false;
  const bound = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_READY_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), bound);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "token=readiness-probe",
      signal: ac.signal,
    });
    const status = Number(res?.status);
    let body;
    try {
      body = await res.json();
    } catch {
      return false;
    }
    return introspectionProbeOk(status, body);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every readiness check. Names only; no secrets.
 *
 * @param {object} [options]
 * @param {Array<{name: string}>} [options.definitions]
 * @param {Array<object>} [options.sites]
 * @param {object} [options.inboundCfg]
 * @param {boolean} [options.loopbackBind]
 * @param {typeof fetch} [options.fetchFn]
 * @returns {Promise<{ok: boolean, failed: string[]}>}
 */
export async function runReadyChecks({
  definitions = [],
  sites = [],
  inboundCfg = {},
  loopbackBind = false,
  fetchFn = fetch,
} = {}) {
  const failed = [];
  const introspectionUrl = typeof inboundCfg.introspectionUrl === "string"
    ? inboundCfg.introspectionUrl
    : "";
  if (introspectionUrl) {
    const reachable = await checkIntrospectionReachable({
      url: introspectionUrl,
      timeoutMs: inboundCfg.introspectionTimeoutMs,
      fetchFn,
    });
    if (!reachable) failed.push(CHECK_INTROSPECTION);
  } else if (inboundCfg.issuer && inboundCfg.audience) {
    failed.push(CHECK_INTROSPECTION);
  } else if (!loopbackBind) {
    failed.push(CHECK_AUTH);
  }

  if (!checkScopeTable(definitions)) failed.push(CHECK_SCOPE_TABLE);
  if (!checkAllowlists({ sites, inboundCfg, loopbackBind })) failed.push(CHECK_ALLOWLISTS);

  return { ok: failed.length === 0, failed };
}

/**
 * Single-flight + short-lived cache around {@link runReadyChecks}.
 * Concurrent callers share one outbound probe; the result is reused for
 * {@link READY_PROBE_CACHE_MS} (override with `cacheMs` in tests).
 *
 * @param {object} [options] Forwarded to {@link runReadyChecks}.
 * @param {number} [options.cacheMs]
 * @param {() => number} [options.now]
 * @returns {() => Promise<{ok: boolean, failed: string[]}>}
 */
export function createReadyChecker(options = {}) {
  const cacheMs = Number.isInteger(options.cacheMs) && options.cacheMs > 0
    ? options.cacheMs
    : READY_PROBE_CACHE_MS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  let inflight = null;
  /** @type {{result: {ok: boolean, failed: string[]}, expiresAt: number}|null} */
  let cached = null;

  return async function checkReady() {
    const t = now();
    if (cached && t < cached.expiresAt) return cached.result;
    if (inflight) return inflight;
    inflight = runReadyChecks(options)
      .then((result) => {
        cached = { result, expiresAt: now() + cacheMs };
        return result;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/**
 * JSON body for GET /ready. Failed check names only.
 *
 * @param {{ok: boolean, failed: string[]}} result
 * @returns {object}
 */
export function readyBody(result) {
  if (result.ok) return { status: "ok" };
  return { status: "not_ready", failed: [...result.failed] };
}
