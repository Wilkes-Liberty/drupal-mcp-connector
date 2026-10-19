/**
 * Timeouts for outbound catalog hops (OAuth, readiness, Drupal /mcp).
 *
 * Listing wait is a race in `site-catalog.js` — it must not abort token,
 * readiness, initialize, or tools/list. Request-kill extras still cancel.
 */

import { combineAbortSignals } from "./abort-signals.js";

/** Error.code reserved for an explicit catalog deadline (tests / callers). */
export const CATALOG_DEADLINE_CODE = "CATALOG_DEADLINE";

/**
 * Whether an error is an explicit catalog deadline.
 *
 * @param {*} error
 * @returns {boolean}
 */
export function isCatalogDeadlineError(error) {
  return Boolean(error && typeof error === "object" && error.code === CATALOG_DEADLINE_CODE);
}

/**
 * Combine a request timeout with any extra cancel signals (for example a
 * killed inbound request). Does not attach a listing-wait abort.
 *
 * @param {number} timeoutMs
 * @param {...AbortSignal|null|undefined} extra
 * @returns {AbortSignal}
 */
export function catalogAwareTimeout(timeoutMs, ...extra) {
  return combineAbortSignals(
    AbortSignal.timeout(timeoutMs),
    ...extra,
  ) ?? AbortSignal.timeout(timeoutMs);
}
