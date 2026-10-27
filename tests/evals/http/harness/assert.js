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
  error,
  description,
  body = "Unauthorized",
} = {}) {
  check(h, () => expect(res.status, `${label}: status`).toBe(status));
  check(h, () => expect(res.headers["www-authenticate"], `${label}: Bearer`).toMatch(/^Bearer\b/i));
  check(h, () => {
    const challenge = expect(res.headers["www-authenticate"], `${label}: error code`);
    if (error) challenge.toContain(`error="${error}"`);
    else challenge.not.toMatch(/\berror=/);
  });
  check(h, () => {
    const challenge = expect(res.headers["www-authenticate"], `${label}: description`);
    if (description) challenge.toContain(`error_description="${description}"`);
    else challenge.not.toMatch(/\berror_description=/);
  });
  if (h.resourceMetadataUrl) {
    check(h, () => expect(res.headers["www-authenticate"], `${label}: resource_metadata`)
      .toContain(`resource_metadata="${h.resourceMetadataUrl}"`));
  }
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
 * The modern/legacy handler was not entered (a-1). Distinct from a 401
 * that is written after dispatch.
 *
 * @param {object} h
 * @param {string} label
 */
export function expectHandlerUnreached(h, label) {
  check(h, () => expect(h.counters.ch, `${label}: handler was not reached`).toBe(0));
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
 * An authenticated transport-level denial (Origin, protocol version, session).
 * Not a 401 — identity already resolved.
 *
 * @param {object} h
 * @param {string} label
 * @param {{status: number, headers: object, text: string}} res
 * @param {{status: number, code?: number}} expected
 */
export function expectTransportDenied(h, label, res, { status, code } = {}) {
  check(h, () => expect(res.status, `${label}: status`).toBe(status));
  check(h, () => expect(res.headers["www-authenticate"], `${label}: no 401 challenge`).toBeUndefined());
  check(h, () => expect(res.headers["mcp-session-id"], `${label}: no session issued`).toBeUndefined());
  if (code !== undefined) {
    let parsed = {};
    try {
      parsed = JSON.parse(res.text);
    } catch {
      parsed = {};
    }
    check(h, () => expect(parsed.error?.code, `${label}: JSON-RPC code`).toBe(code));
  }
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
 * Authenticated tools/call that was refused after token verification
 * (closed entitlement denial). HTTP 200 with an MCP isError envelope;
 * the text names no site.
 * @param {object} h
 * @param {string} label
 * @param {{status: number, headers: object, text: string}} res
 * @param {{message?: RegExp}} [expected]
 */
export function expectToolDenied(h, label, res, { message = /Access denied:.*[Nn]ot entitled/ } = {}) {
  check(h, () => expect(res.status, `${label}: status`).toBe(200));
  check(h, () => expect(res.headers["www-authenticate"], `${label}: no challenge`).toBeUndefined());
  const body = JSON.parse(res.text);
  const text = body.result?.content?.[0]?.text ?? "";
  check(h, () => expect(body.result?.isError, `${label}: isError`).toBe(true));
  check(h, () => expect(text, `${label}: closed denial`).toMatch(message));
  check(h, () => expect(text, `${label}: no site name in denial`).not.toMatch(/site-a|site-b/i));
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

/**
 * Startup must not have opened a listener.
 * @param {object} h
 * @param {string} label
 * @param {{started?: boolean}} result
 */
export function expectStartupNotListening(h, label, result) {
  check(h, () => expect(result.started, `${label}: no listener opened`).toBe(false));
}

/**
 * Exactly one audit row for `requestId`, with the closed denial code and status.
 * @param {object} h
 * @param {string} label
 * @param {string} requestId
 * @param {{code: string, status: number}} expected
 */
export function expectAuditRow(h, label, requestId, { code, status, route = "/mcp" }) {
  const matches = (h.auditRows ?? []).filter((row) => row.requestId === requestId);
  check(h, () => expect(matches, `${label}: exactly one row`).toHaveLength(1));
  const row = matches[0] ?? {};
  check(h, () => expect(row.code, `${label}: code`).toBe(code));
  check(h, () => expect(row.status, `${label}: status`).toBe(status));
  check(h, () => expect(row.route, `${label}: route`).toBe(route));
  check(h, () => expect(typeof row.timestamp, `${label}: timestamp`).toBe("string"));
  check(h, () => expect(typeof row.method, `${label}: method`).toBe("string"));
  check(h, () => expect(row.requestId, `${label}: request id`).toBe(requestId));
}

/**
 * No audit row contains the sentinel secret (token, cookie, or body).
 * @param {object} h
 * @param {string} label
 * @param {string} sentinel
 */
export function expectNoSecretInAudit(h, label, sentinel) {
  const haystack = JSON.stringify(h.auditRows ?? []);
  check(h, () => expect(haystack.includes(sentinel), `${label}: sentinel absent from every row`).toBe(false));
}
