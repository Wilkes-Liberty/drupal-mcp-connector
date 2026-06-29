/**
 * Server-tool bridge — call governed MCP tools exposed by Drupal.
 *
 * The connector itself is an MCP *server* for the AI client. For governed
 * configuration operations, Drupal exposes its own MCP tools server-side
 * (the `mcp_server_tool_bridge` / `mcp_sentinel` modules). This module makes
 * the connector an MCP *client* of that server so config get/list/set are
 * mediated by Drupal's authoritative governance layer rather than by drush.
 *
 * Transport: JSON-RPC 2.0 over the MCP Streamable-HTTP transport, POSTed to the
 * per-site `serverTools.url` endpoint and authenticated with the same OAuth
 * bearer used for JSON:API. Drupal's `mcp_server` is session-mandatory, so each
 * call site performs the MCP session handshake — `initialize` (read the
 * `Mcp-Session-Id` response header) → `notifications/initialized` → `tools/call`
 * carrying that session id. The session is cached per site and transparently
 * re-initialised when the server expires it.
 *
 * Config (per site):
 *   "serverTools": { "url": "/mcp" }   // path is resolved against site.baseUrl
 *
 * Tools are NOT functional until the Drupal-side governed config tools ship;
 * until then the server returns a tool-not-found error, surfaced verbatim.
 */

import fetch from "node-fetch";
import { authHeadersAsync, clientHeaders, CLIENT_VERSION } from "./config.js";
import { clearToken } from "./oauth.js";

/**
 * Canonical server-side tool names for governed config operations.
 *
 * Drupal's mcp_server_tool_bridge exposes every Tool-API tool through the MCP
 * protocol under the derivative name `tool_api.<mcp_tool_config id>`, so the
 * governed config tools registered against mcp_sentinel's McpConfigGet/List/Set
 * plugins surface as `tool_api.mcp_sentinel_config_*`. Keep the mapping here so
 * a server-side rename is a one-line change.
 */
export const SERVER_TOOLS = {
  configGet:  "tool_api.mcp_sentinel_config_get",
  configList: "tool_api.mcp_sentinel_config_list",
  configSet:  "tool_api.mcp_sentinel_config_set",
  // Read-only audit methods. These surface privileged log/config/module/
  // permission/requirements data the standard JSON:API/GraphQL backends do not
  // expose. They are companion work in the mcp_sentinel repo; until they ship,
  // a call returns a tool-not-found error which the audit tools treat as a
  // gated/unavailable source (and fall back to the drush bridge where one exists).
  log404:         "tool_api.mcp_sentinel_log_404",
  configStatus:   "tool_api.mcp_sentinel_config_status",
  moduleList:     "tool_api.mcp_sentinel_module_list",
  permissionList: "tool_api.mcp_sentinel_permission_list",
  requirements:   "tool_api.mcp_sentinel_requirements",
};

/** MCP protocol version advertised on the handshake and every subsequent POST. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

// Monotonic JSON-RPC request id. A simple counter keeps ids unique per process
// without relying on Math.random()/Date.now().
let rpcId = 0;

/**
 * Per-site MCP session cache, keyed by site._name. Holds the `Mcp-Session-Id`
 * issued by the server's `initialize` response; cleared and re-acquired when the
 * server reports the session is gone (expiry).
 */
const sessions = new Map();

/**
 * Resolve a site's server-tools endpoint, or throw a clear, actionable error
 * when the site has no `serverTools` block (mirrors the drush bridge's
 * graceful "not configured" failure).
 * @param {object} site Resolved site config.
 * @returns {string} Fully-qualified endpoint URL.
 * @throws {Error} if the site has no serverTools.url configured.
 */
function resolveEndpoint(site) {
  const url = site.serverTools?.url;
  if (!url) {
    throw new Error(
      `Server-tool bridge not configured for site "${site._name}". ` +
      "Add a \"serverTools\": { \"url\": \"/mcp\" } block to this site's config. " +
      "See docs/integration-contract.md."
    );
  }
  // Absolute URL wins; otherwise resolve the path against the site base URL.
  return /^https?:\/\//.test(url) ? url : `${site.baseUrl}${url}`;
}

/**
 * Build the common header set for an MCP POST: JSON-RPC content type, dual Accept
 * (the server may answer with JSON or an SSE stream), the protocol version, the
 * outbound client identity, the site's auth, and — when present — the session id.
 * @param {object} site Resolved site config.
 * @param {?string} sessionId Active MCP session id, or null before initialize.
 * @returns {Promise<Object<string,string>>} Header map.
 */
async function baseHeaders(site, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...clientHeaders(),
    ...(await authHeadersAsync(site)),
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return headers;
}

/**
 * Read an MCP response body once, handling both `application/json` and
 * `text/event-stream` (SSE) transports. SSE frames are split on blank lines and
 * each event's concatenated `data:` payload is parsed as the JSON-RPC body.
 * @param {object} res node-fetch Response.
 * @returns {Promise<{body: ?object, rawText: string}>} Parsed JSON-RPC body
 *   (null for empty/unparseable bodies, e.g. a notification's 202) plus the raw text.
 */
async function readBody(res) {
  const rawText = await res.text();
  if (!rawText) return { body: null, rawText };

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    return { body: parseSse(rawText), rawText };
  }
  try {
    return { body: JSON.parse(rawText), rawText };
  } catch {
    return { body: null, rawText };
  }
}

/**
 * Parse an SSE stream into the JSON-RPC body it carries. Returns the last event
 * whose `data:` payload parses to a JSON-RPC object (a `tools/call` reply is a
 * single event), or null if none do.
 * @param {string} text Raw event-stream text.
 * @returns {?object} The decoded JSON-RPC body, or null.
 */
function parseSse(text) {
  let found = null;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      found = JSON.parse(data);
    } catch {
      // Skip non-JSON events (e.g. comments/keep-alives).
    }
  }
  return found;
}

/**
 * Perform the MCP session handshake against the server and cache the resulting
 * session id: `initialize` (read the `Mcp-Session-Id` response header) followed
 * by a best-effort `notifications/initialized`. A 401 on OAuth sites triggers a
 * single token-refresh retry, mirroring the tools/call path.
 * @param {object} site Resolved site config.
 * @param {string} endpoint Fully-qualified endpoint URL.
 * @returns {Promise<string>} The issued MCP session id.
 * @throws {Error} on transport failure, a JSON-RPC error, or a missing session id.
 */
async function initializeSession(site, endpoint) {
  const payload = {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "drupal-mcp-connector", version: CLIENT_VERSION },
    },
  };

  const post = async () =>
    fetch(endpoint, {
      method: "POST",
      headers: await baseHeaders(site, null),
      body: JSON.stringify(payload),
    });

  let res = await post();
  if (res.status === 401 && site.oauth) {
    clearToken(site);
    res = await post();
  }

  const { body, rawText } = await readBody(res);
  if (!res.ok) {
    throw new Error(`Server-tool session initialize failed ${res.status}: ${rawText}`);
  }
  if (body?.error) {
    const { code, message } = body.error;
    const hasCode = code !== undefined && code !== null;
    throw new Error(`Server-tool session initialize error${hasCode ? ` (${code})` : ""}: ${message}`);
  }

  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error(
      `Server-tool session initialize for site "${site._name}" returned no Mcp-Session-Id header.`
    );
  }

  // Best-effort: the server may not require notifications/initialized, and a
  // non-2xx here must not fail the call. Errors are swallowed deliberately.
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: await baseHeaders(site, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  } catch {
    // Notification is advisory; proceed with the established session.
  }

  sessions.set(site._name, sessionId);
  return sessionId;
}

/**
 * Return the cached session id for a site, initialising one if absent.
 * @param {object} site Resolved site config.
 * @param {string} endpoint Fully-qualified endpoint URL.
 * @returns {Promise<string>} The active MCP session id.
 */
async function ensureSession(site, endpoint) {
  const cached = sessions.get(site._name);
  return cached || initializeSession(site, endpoint);
}

/**
 * Whether a tools/call response indicates the MCP session is gone (expired or
 * unknown), warranting a single re-initialise and replay: an HTTP 404, or the
 * server's `-32600` "session id is REQUIRED" JSON-RPC error.
 * @param {object} res node-fetch Response.
 * @param {?object} body Parsed JSON-RPC body, if any.
 * @returns {boolean}
 */
function isSessionError(res, body) {
  if (res.status === 404) return true;
  const err = body?.error;
  if (!err) return false;
  return err.code === -32600 || /session id/i.test(String(err.message || ""));
}

/**
 * Call a governed MCP tool on the Drupal server via JSON-RPC `tools/call`.
 *
 * Establishes/reuses an MCP session (see initializeSession) and POSTs the
 * `tools/call`. Two single-shot recoveries layer on top of each other: a 401 on
 * OAuth sites clears and re-acquires the token then replays (same session); a
 * server-side session expiry re-initialises the session then replays.
 * @param {object} site Resolved site config (provides baseUrl + auth).
 * @param {string} toolName Server-side MCP tool name (see SERVER_TOOLS).
 * @param {object} [args] Tool arguments object.
 * @returns {Promise<*>} The tool's structured result.
 * @throws {Error} on transport failure, JSON-RPC error, or tool error.
 */
export async function callServerTool(site, toolName, args = {}) {
  const endpoint = resolveEndpoint(site);
  const payload = {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  let sessionId = await ensureSession(site, endpoint);
  let refreshedAuth = false;
  let reinitedSession = false;

  // Retry loop: at most one auth refresh and one session re-init, each replayed once.
  while (true) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: await baseHeaders(site, sessionId),
      body: JSON.stringify(payload),
    });
    const { body, rawText } = await readBody(res);

    // OAuth sites: a 401 may mean the token expired server-side. Refresh once.
    if (res.status === 401 && site.oauth && !refreshedAuth) {
      refreshedAuth = true;
      clearToken(site);
      continue;
    }

    // Session expired/unknown: re-initialise once and replay.
    if (isSessionError(res, body) && !reinitedSession) {
      reinitedSession = true;
      sessions.delete(site._name);
      sessionId = await ensureSession(site, endpoint);
      continue;
    }

    if (!res.ok) {
      throw new Error(`Server-tool call ${toolName} failed ${res.status}: ${rawText}`);
    }

    // JSON-RPC transport-level error.
    if (body?.error) {
      const { code, message } = body.error;
      const hasCode = code !== undefined && code !== null;
      throw new Error(`Server-tool ${toolName} error${hasCode ? ` (${code})` : ""}: ${message}`);
    }

    // MCP tools/call result: { content: [...], isError?: boolean }.
    const result = body?.result;
    if (result?.isError) {
      const detail = extractTextContent(result) || "tool reported an error";
      throw new Error(`Server-tool ${toolName} reported an error: ${detail}`);
    }
    return result;
  }
}

/**
 * Extract the structured data a server tool returned, for callers (the audit
 * tools) that need to inspect the payload rather than relay it. Prefers the MCP
 * `structuredContent` field; otherwise parses the joined text content as JSON,
 * falling back to the raw text when it isn't JSON.
 * @param {object} result MCP tools/call result (as returned by callServerTool).
 * @returns {*} Parsed structured data, raw text, or null when empty.
 */
export function toolResultData(result) {
  if (!result) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = extractTextContent(result);
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return text; }
}

/**
 * Pull the concatenated text from an MCP tool result's content array.
 * @param {object} result MCP tools/call result.
 * @returns {string} Joined text content (empty string if none).
 */
function extractTextContent(result) {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}
