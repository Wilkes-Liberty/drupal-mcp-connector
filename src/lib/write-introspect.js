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

/**
 * In-process write re-introspection guard. Production leaves `required`
 * true. Tests call {@link setWriteReintrospectGuard} for a red run.
 */
export const WRITE_REINTROSPECT_GUARD = { required: true };

/**
 * Flip {@link WRITE_REINTROSPECT_GUARD} for a red-run. Restore `true`
 * after the assertion; production code never calls this.
 *
 * @param {boolean} required
 * @returns {void}
 */
export function setWriteReintrospectGuard(required) {
  WRITE_REINTROSPECT_GUARD.required = Boolean(required);
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
  readyCache = null,
} = {}) {
  const session = getRequestAuthSession();
  const who = identity !== undefined ? identity : session?.identity;
  if (isLocalOperator(who)) return;
  if (!WRITE_REINTROSPECT_GUARD.required) return;

  const token = bearer ?? session?.bearer;
  const inspect = introspect ?? session?.introspect;
  // Stdio and unit tests inject an identity with no inbound bearer.
  // A live network call always has one; missing introspect then fails closed.
  if (typeof token !== "string" || !token) return;
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
    denyAndCancel(who);
  }
  if (!introspectionAllowsWrite(body)) denyAndCancel(who);
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
