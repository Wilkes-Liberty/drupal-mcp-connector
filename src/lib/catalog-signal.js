/**
 * Timeouts for outbound catalog hops (OAuth, readiness, Drupal /mcp).
 *
 * Listing wait is a race in `site-catalog.js` — it must not abort token,
 * readiness, initialize, or tools/list. Request-kill extras still cancel.
 * Stdio stdin/transport close aborts in-flight hops so the process can exit.
 */

import { combineAbortSignals } from "./abort-signals.js";

let shutdown = new AbortController();

/**
 * Signal aborted when the stdio process is shutting down.
 *
 * @returns {AbortSignal}
 */
export function catalogShutdownSignal() {
  return shutdown.signal;
}

/**
 * Abort in-flight catalog hops (stdio stdin/transport close).
 *
 * @returns {void}
 */
export function abortCatalogWork() {
  if (!shutdown.signal.aborted) shutdown.abort();
}

/**
 * Restore a live shutdown controller (tests).
 *
 * @returns {void}
 */
export function resetCatalogShutdown() {
  shutdown = new AbortController();
}

/**
 * Timeout that does not keep the event loop alive.
 *
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
function unrefTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort();
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  return controller.signal;
}

/**
 * Combine a request timeout with shutdown and any extra cancel signals
 * (for example a killed inbound request). Does not attach a listing-wait abort.
 *
 * @param {number} timeoutMs
 * @param {...AbortSignal|null|undefined} extra
 * @returns {AbortSignal}
 */
export function catalogAwareTimeout(timeoutMs, ...extra) {
  return combineAbortSignals(
    unrefTimeoutSignal(timeoutMs),
    shutdown.signal,
    ...extra,
  ) ?? unrefTimeoutSignal(timeoutMs);
}
