/**
 * Shared assertion helpers. Every case must go through these: they count the
 * assertions they run, and a case that runs none fails the pack.
 */

import { expect } from "vitest";

function check(h, run) {
  h.assertions += 1;
  run();
}

/**
 * A pre-dispatch refusal: closed result, no session issued, nothing dispatched.
 * @param {object} h harness handle
 * @param {string} label
 * @param {{status: number, headers: object, text: string}} res
 * @param {{status?: number, error?: string, description?: string, body?: string}} [expected]
 */
export function expectRefused(h, label, res, {
  status = 401,
  error = "invalid_token",
  description = "Bearer token required",
  body = "Unauthorized",
} = {}) {
  check(h, () => expect(res.status, `${label}: status`).toBe(status));
  check(h, () => expect(res.headers["www-authenticate"], `${label}: error code`).toContain(`error="${error}"`));
  check(h, () => expect(res.headers["www-authenticate"], `${label}: description`)
    .toContain(`error_description="${description}"`));
  check(h, () => expect(res.text, `${label}: body`).toBe(body));
  check(h, () => expect(res.headers["mcp-session-id"], `${label}: no session issued`).toBeUndefined());
}

/**
 * Zero dispatch: Ch, Ct, and Cu are all still at the given baseline (default 0).
 * @param {object} h
 * @param {string} label
 */
export function expectNoDispatch(h, label) {
  const { ch, ct, cu } = h.dispatchCounts();
  check(h, () => expect({ ch, ct, cu }, `${label}: dispatch counters (Ch, Ct, Cu)`).toEqual({ ch: 0, ct: 0, cu: 0 }));
}

/**
 * A legitimate request that was served.
 * @param {object} h
 * @param {string} label
 * @param {{status: number, headers: object, text: string}} res
 * @param {{status?: number}} [expected]
 */
export function expectAllowed(h, label, res, { status = 200 } = {}) {
  check(h, () => expect(res.status, `${label}: status`).toBe(status));
  check(h, () => expect(res.headers["www-authenticate"], `${label}: no challenge`).toBeUndefined());
}

/**
 * Generic counted equality for allow-twin facts (entitlement, counters, canaries).
 * @param {object} h
 * @param {string} label
 * @param {unknown} actual
 * @param {unknown} expected
 */
export function expectEqual(h, label, actual, expected) {
  check(h, () => expect(actual, label).toEqual(expected));
}

/**
 * Startup refusal: the inbound-mode decision must be fatal with a named reason.
 * @param {object} h
 * @param {string} label
 * @param {{mode: string, reason?: string}} decision
 */
export function expectStartupFatal(h, label, decision) {
  check(h, () => expect(decision.mode, `${label}: mode`).toBe("fatal"));
  check(h, () => expect(decision.reason, `${label}: named reason`).toEqual(expect.any(String)));
}
