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
function emptyPost() {
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

/** Authenticated-invalid POST: JSON-RPC batch array (DEV-840). */
export function jsonRpcBatch() {
  return {
    method: "POST",
    headers: {
      accept: ACCEPT,
      "content-type": "application/json",
      "mcp-protocol-version": MODERN_VERSION,
    },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping", params: {} },
      { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
    ]),
  };
}

/** POST whose Accept lists neither JSON nor SSE. */
export function badAcceptPost() {
  const request = modernPost("tools/list");
  request.headers.accept = "text/plain";
  return request;
}

/** GET /health liveness probe. */
export function healthGet() {
  return { method: "GET", path: "/health", headers: { accept: "application/json" } };
}

/** GET RFC 9728 protected-resource metadata. */
export function resourceMetadataGet(path = "/.well-known/oauth-protected-resource") {
  return {
    method: "GET",
    path,
    headers: { accept: "application/json" },
  };
}

/** GET /usage (edge). */
export function usageGet() {
  return { method: "GET", path: "/usage", headers: { accept: "application/json" } };
}

/** GET /assessor (edge). */
export function assessorGet() {
  return { method: "GET", path: "/assessor", headers: { accept: "application/json" } };
}

/**
 * The T1 unauthenticated request table. T7 imports the same builders.
 * @returns {Array<[string, {method: string, headers: object, body?: string}]>}
 */
export function unauthenticatedRequests() {
  return [
    ["POST initialize", legacyInitialize()],
    ["POST server/discover", modernPost("server/discover")],
    ["POST tools/list", modernPost("tools/list")],
    ["POST tools/call", modernPost("tools/call", { name: "drupal_list_nodes", arguments: {} }, { name: "drupal_list_nodes" })],
    ["POST resources/list", modernPost("resources/list")],
    ["POST prompts/list", modernPost("prompts/list")],
    ["POST ping", legacyPost("ping")],
    ["POST notification", legacyPost("notifications/initialized", {}, { notification: true })],
    ["POST empty body", emptyPost()],
    ["GET without session", sessionRequest("GET")],
    ["GET with session", sessionRequest("GET", { sessionId: "eval-session-not-issued" })],
    ["DELETE without session", sessionRequest("DELETE")],
    ["DELETE with session", sessionRequest("DELETE", { sessionId: "eval-session-not-issued" })],
  ];
}
