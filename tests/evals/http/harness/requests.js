/**
 * One request builder for deny and allow cases. The allow twin (T7) is built
 * from the same builders as the deny cases (T1) with exactly one input
 * changed: a valid token.
 */

const ACCEPT = "application/json, text/event-stream";
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";

const modernMeta = () => ({
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "eval-http", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
});

/**
 * A modern (stateless, 2026-07-28) JSON-RPC POST.
 * @param {string} method
 * @param {object} [params]
 * @param {{id?: number|string, name?: string}} [options]
 * @returns {{method: "POST", headers: object, body: string}}
 */
export function modernPost(method, params = {}, { id = 1, name } = {}) {
  return {
    method: "POST",
    headers: {
      accept: ACCEPT,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": MODERN_VERSION,
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: modernMeta() },
    }),
  };
}

/**
 * A legacy (2025-11-25, sessionful) JSON-RPC POST.
 * @param {string} method
 * @param {object} [params]
 * @param {{id?: number|string, sessionId?: string, notification?: boolean}} [options]
 * @returns {{method: "POST", headers: object, body: string}}
 */
export function legacyPost(method, params = {}, { id = 1, sessionId, notification = false } = {}) {
  return {
    method: "POST",
    headers: {
      accept: ACCEPT,
      "content-type": "application/json",
      "mcp-protocol-version": LEGACY_VERSION,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
  };
}

/** POST /mcp with the content type set and no body at all. */
export function emptyPost() {
  return { method: "POST", headers: { accept: ACCEPT, "content-type": "application/json" }, body: "" };
}

/**
 * GET or DELETE /mcp, with or without a session id.
 * @param {"GET"|"DELETE"} method
 * @param {{sessionId?: string}} [options]
 */
export function sessionRequest(method, { sessionId } = {}) {
  return {
    method,
    headers: {
      accept: method === "GET" ? "text/event-stream" : ACCEPT,
      "mcp-protocol-version": LEGACY_VERSION,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
  };
}

export const legacyInitialize = (id = 1) => legacyPost("initialize", {
  protocolVersion: LEGACY_VERSION,
  capabilities: {},
  clientInfo: { name: "eval-http", version: "0" },
}, { id });
