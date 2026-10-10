/**
 * Dispatch counters.
 *   Ch: calls into the modern or legacy handler (dispatch past the auth gate).
 *   Ct: tool bodies reached.
 * Cu (requests that reached the fake upstream) lives in fake-drupal.js.
 */

/**
 * @returns {{ch: number, ct: number, wrapHandler: Function, countTool: () => void}}
 */
export function createCounters() {
  const counters = {
    ch: 0,
    ct: 0,
    /**
     * Wrap a dispatch handler so each call increments Ch.
     * @param {Function} handler
     * @returns {Function}
     */
    wrapHandler(handler) {
      return (...args) => {
        counters.ch += 1;
        return handler(...args);
      };
    },
    countTool() {
      counters.ct += 1;
    },
  };
  return counters;
}
