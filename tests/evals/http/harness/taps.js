/**
 * Response tap and canary scanner. Records what the caller could see
 * (status, headers, body) and scans that transcript, not chosen fields.
 *
 * Increment 1 scans response headers and bodies only. SSE frames, captured
 * logs, and the scanner self-test (X1s) arrive with increment 4.
 */

/**
 * @returns {{responses: object[], serverSide: object[], record: Function, scan: Function}}
 */
export function createTap() {
  const tap = {
    responses: [],
    /** Server-side observations, one per request (e.g. whether the body was read). */
    serverSide: [],
    record(entry) {
      tap.responses.push(entry);
    },
    /**
     * Count canary occurrences per tenant across every recorded response.
     * @param {Record<string, {secret: string, host: string}>} canaries
     * @returns {Record<string, number>}
     */
    scan(canaries) {
      const haystack = tap.responses
        .map((entry) => `${JSON.stringify(entry.headers)}\n${entry.text}`)
        .join("\n");
      const found = {};
      for (const [tenant, { secret, host }] of Object.entries(canaries)) {
        found[tenant] = haystack.split(secret).length - 1 + haystack.split(host).length - 1;
      }
      return found;
    },
  };
  return tap;
}
