/**
 * DEV-846: re-introspect the bearer before a governed write commits.
 *
 * RFC 7662, live at the issuer. The 8s `/ready` probe cache
 * (`READY_PROBE_CACHE_MS`) is never consulted here: a kill must not
 * wait for that window. Inactive or killed tokens abort with the same
 * generic deny as a missing principal. The response is not echoed.
 */

import { introspectToken } from "./http-auth.js";
import { activeInFlightRegistry, inFlightKeysFromIdentity } from "./in-flight.js";
import { READY_PROBE_CACHE_MS } from "./ops-ready.js";
import { getRequestAuthSession, isLocalOperator } from "./principal.js";
import { principalDenied } from "./principal-context.js";
import { assertTestOnly } from "./test-only.js";

/**
 * In-process write re-introspection guard. Production leaves `required`
 * true. Tests call {@link setWriteReintrospectGuard} for a red run.
 */
export const WRITE_REINTROSPECT_GUARD = { required: true };

/**
 * Per-branch skips for red companions. Production leaves every flag
 * false. Each red test flips only the branch it covers.
 */
export const WRITE_REINTROSPECT_SKIP = {
  missingBearer: false,
  throwOrTimeout: false,
  inactiveOrKilled: false,
};

/**
 * Flip {@link WRITE_REINTROSPECT_GUARD} for a red-run. Restore `true`
 * after the assertion; production code never calls this.
 *
 * @param {boolean} required
 * @returns {void}
 */
export function setWriteReintrospectGuard(required) {
  assertTestOnly("setWriteReintrospectGuard");
  WRITE_REINTROSPECT_GUARD.required = Boolean(required);
}

/**
 * Flip one {@link WRITE_REINTROSPECT_SKIP} branch. Restore `false`
 * after the assertion; production code never calls this.
 *
 * @param {"missingBearer"|"throwOrTimeout"|"inactiveOrKilled"} branch
 * @param {boolean} skip
 * @returns {void}
 */
export function setWriteReintrospectSkip(branch, skip) {
  assertTestOnly("setWriteReintrospectSkip");
  const on = Boolean(skip);
  switch (branch) {
    case "missingBearer":
      WRITE_REINTROSPECT_SKIP.missingBearer = on;
      return;
    case "throwOrTimeout":
      WRITE_REINTROSPECT_SKIP.throwOrTimeout = on;
      return;
    case "inactiveOrKilled":
      WRITE_REINTROSPECT_SKIP.inactiveOrKilled = on;
      return;
    default:
      throw new Error(`Unknown write-reintrospect skip branch "${branch}".`);
  }
}

/**
 * Restore every {@link WRITE_REINTROSPECT_SKIP} flag. Production never
 * calls this.
 *
 * @returns {void}
 */
export function resetWriteReintrospectSkip() {
  assertTestOnly("resetWriteReintrospectSkip");
  WRITE_REINTROSPECT_SKIP.missingBearer = false;
  WRITE_REINTROSPECT_SKIP.throwOrTimeout = false;
  WRITE_REINTROSPECT_SKIP.inactiveOrKilled = false;
}

/**
 * Whether a token introspection body admits a governed write.
 * `active` must be true. A Paladin `killed` flag is a deny. The body
 * is never returned to the caller.
 *
 * @param {object|null|undefined} body
 * @returns {boolean}
 */
export function introspectionAllowsWrite(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (body.active !== true) return false;
  if (body.killed === true) return false;
  return true;
}

/**
 * True when this helper would consult the 8s ready cache. Production
 * always returns false. A test-only red path can force the cache so
 * the deny test can fail.
 */
export const WRITE_INTROSPECT_CACHE = { useReadyCache: false };

/**
 * Flip the write-path cache consult for a red-run. Production never
 * calls this; {@link READY_PROBE_CACHE_MS} must not mask a kill.
 *
 * @param {boolean} useReadyCache
 * @returns {void}
 */
export function setWriteIntrospectUsesReadyCache(useReadyCache) {
  assertTestOnly("setWriteIntrospectUsesReadyCache");
  WRITE_INTROSPECT_CACHE.useReadyCache = Boolean(useReadyCache);
}

/**
 * Live RFC 7662 check used immediately before a governed write commits.
 *
 * @param {object} [options]
 * @param {string} [options.bearer]
 * @param {(token: string) => Promise<object|null>} [options.introspect]
 * @param {object|null} [options.identity]
 * @param {{active?: boolean}|null} [options.readyCache] Test-only 8s cache stand-in.
 * @returns {Promise<void>}
 * @throws {import("./security.js").SecurityError}
 */
export async function assertLiveTokenForGovernedWrite({
  bearer,
  introspect,
  identity,
  surface: surfaceHint = null,
  readyCache = null,
} = {}) {
  const session = getRequestAuthSession();
  const who = identity !== undefined ? identity : session?.identity;
  const surface = surfaceHint ?? session?.surface ?? null;

  // Relay edge already live-checked this write. The Paladin bearer never
  // crosses the tunnel, so the tenant agent cannot introspect again.
  if (session?.tokenLive === true) return;

  const token = bearer ?? session?.bearer;
  if (typeof token !== "string" || !token) {
    // Network-origin missing bearer is denied even for the loopback
    // unauthenticated local operator. Only stdio may skip.
    if (surface === "network" && !WRITE_REINTROSPECT_SKIP.missingBearer) {
      denyAndCancel(who);
    }
    return;
  }

  if (isLocalOperator(who)) return;
  if (!WRITE_REINTROSPECT_GUARD.required) return;

  const inspect = introspect ?? session?.introspect;
  if (typeof inspect !== "function") denyAndCancel(who);

  // The 8s ready cache is a reachability probe. Consulting it here would
  // mask a kill for READY_PROBE_CACHE_MS. Production never does.
  if (WRITE_INTROSPECT_CACHE.useReadyCache && readyCache && readyCache.active === true) {
    return;
  }
  void READY_PROBE_CACHE_MS;

  let body;
  try {
    body = await inspect(token);
  } catch {
    if (!WRITE_REINTROSPECT_SKIP.throwOrTimeout) denyAndCancel(who);
    return;
  }
  if (!introspectionAllowsWrite(body)) {
    if (!WRITE_REINTROSPECT_SKIP.inactiveOrKilled) denyAndCancel(who);
  }
}

function denyAndCancel(identity) {
  const keys = inFlightKeysFromIdentity(identity);
  if (keys) activeInFlightRegistry().cancel(keys);
  throw principalDenied();
}

/**
 * Bind a live introspector that never reads a positive cache.
 *
 * @param {object} options
 * @returns {(token: string) => Promise<object|null>}
 */
export function bindLiveIntrospect(options) {
  return (token) => introspectToken(token, options);
}
