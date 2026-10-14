/**
 * Readiness checks for the mesh-only ops listener (DEV-863).
 *
 * `/ready` probes real dependencies: auth / introspection reachability
 * (bounded timeout) and config completeness (hosted scope table plus
 * entity / Host / Origin allowlists). The 503 body names failing checks
 * only — never URLs, tokens, or other secrets.
 */

import { assertHostedToolScopeTable } from "./tool-scopes.js";
import { resolveSecurityConfig } from "./security.js";
import { resolveAllowedHosts, resolveAllowedOrigins } from "./http-transport.js";

/**
 * Test-only guard (DEV-863). Production callers never flip this. When
 * `required` is false, an unreachable introspection endpoint is treated
 * as ready — the pre-check behavior used to prove the 503 test can fail.
 *
 * @type {{required: boolean}}
 */
export const OPS_READY_INTROSPECTION_GUARD = { required: true };

/**
 * Flip {@link OPS_READY_INTROSPECTION_GUARD} for a red-run. Restore
 * `true` after the assertion; production code never calls this.
 *
 * @param {boolean} required
 * @returns {void}
 */
export function setOpsReadyIntrospectionGuard(required) {
  OPS_READY_INTROSPECTION_GUARD.required = Boolean(required);
}

/** Closed check names returned in a 503 body. */
export const READY_CHECK_NAMES = Object.freeze(["introspection", "auth", "scope_table", "allowlists"]);

const DEFAULT_READY_TIMEOUT_MS = 2000;

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
 * Probe the introspection endpoint. Any HTTP response means reachable;
 * timeout, DNS, or connection errors fail the check. The URL and body
 * never leave this function.
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
  if (!OPS_READY_INTROSPECTION_GUARD.required) return true;
  if (typeof url !== "string" || !url) return false;
  const bound = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_READY_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), bound);
  try {
    await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "token=readiness-probe",
      signal: ac.signal,
    });
    return true;
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
    if (!reachable) failed.push("introspection");
  } else if (inboundCfg.issuer && inboundCfg.audience) {
    failed.push("introspection");
  } else if (!loopbackBind) {
    failed.push("auth");
  }

  if (!checkScopeTable(definitions)) failed.push("scope_table");
  if (!checkAllowlists({ sites, inboundCfg, loopbackBind })) failed.push("allowlists");

  return { ok: failed.length === 0, failed };
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
