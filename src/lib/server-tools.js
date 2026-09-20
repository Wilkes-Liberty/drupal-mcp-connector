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
 * re-initialised when the server expires it. `prompts/list` and `prompts/get`
 * reuse the same session.
 *
 * Config (per site):
 *   "serverTools": { "url": "/mcp" }   // path is resolved against site.baseUrl
 *
 * The governed config tools work only when the source advertises them to this
 * account in `tools/list`; otherwise the call fails closed before it is sent.
 */

import fetch from "node-fetch";
import { createHmac, randomBytes } from "node:crypto";
import { authHeadersAsync, clientHeaders, CLIENT_NAME, CLIENT_VERSION } from "./config.js";
import { consumeBudgetIfEnforced, northboundHeaders, sourceBudgetDenial, getDataFlowContext } from "./data-flow.js";
import { clearToken } from "./oauth.js";
import { cleanErrorText, describeErrorBody } from "./error-body.js";

/** Calls a configured module binding through the registry, without fallback. */
export async function callBoundModuleTool(site, binding, args, required) {
  // Load at invocation: built-in tool definitions are also consumed by the
  // registry's dispatch middleware, so a static import would create a cycle.
  const { createModuleToolRegistry } = await import("./module-tools.js");
  return createModuleToolRegistry().callBinding(site, binding, args, required);
}

/**
 * Tool API ids of the governed config tools (mcp_sentinel's McpConfigGet/List/Set
 * plugins). These are ids, not wire names: the bridge decides the wire name, so
 * it is resolved from the source's `tools/list` (see resolveServerToolName).
 */
export const SERVER_TOOL_IDS = Object.freeze({
  configGet:  "mcp_sentinel_config_get",
  configList: "mcp_sentinel_config_list",
  configSet:  "mcp_sentinel_config_set",
});

/**
 * Wire-name prefixes the Drupal tool bridge has used for a Tool API tool, in
 * order of preference. Current mcp_server releases join the `tool_api` base id
 * and the tool id with `__`; older ones used a dot.
 */
const WIRE_PREFIXES = ["tool_api__", "tool_api."];

/** Upper bound on `tools/list` pages read while resolving a name. */
const MAX_CATALOG_PAGES = 16;

/**
 * Wire names a bridge may advertise for a Tool API id, preferred first.
 * @param {string} id Tool API id, e.g. `mcp_sentinel_config_set`.
 * @returns {string[]} Candidate wire names.
 */
export function serverToolCandidates(id) {
  return WIRE_PREFIXES.map((prefix) => `${prefix}${id}`);
}

/**
 * Read every tool name the source advertises to this caller.
 * @param {object} site Resolved site config.
 * @param {Function} [list] Catalog page reader `(site, cursor) => {tools, nextCursor}`.
 * @returns {Promise<Set<string>>} Advertised tool names.
 * @throws {Error} on a malformed page, a repeated cursor, or too many pages.
 */
export async function advertisedServerToolNames(site, list = listServerTools) {
  const names = new Set();
  const seen = new Set();
  let cursor;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const result = await list(site, cursor);
    if (!Array.isArray(result?.tools)) {
      throw new Error(`Server-tool catalog for site "${site._name}" is malformed: tools/list returned no tools array.`);
    }
    for (const tool of result.tools) {
      if (typeof tool?.name === "string") names.add(tool.name);
    }
    if (result.nextCursor === undefined || result.nextCursor === null) return names;
    if (typeof result.nextCursor !== "string" || seen.has(result.nextCursor)) {
      throw new Error(`Server-tool catalog for site "${site._name}" returned an invalid or repeated cursor.`);
    }
    cursor = result.nextCursor;
    seen.add(cursor);
  }
  throw new Error(`Server-tool catalog for site "${site._name}" exceeds ${MAX_CATALOG_PAGES} pages.`);
}

/**
 * Resolve the wire name the source advertises for a governed config tool.
 *
 * Fails closed: when the catalog lists none of the candidate names, no name is
 * guessed and nothing is called.
 * @param {object} site Resolved site config.
 * @param {string} binding Key of SERVER_TOOL_IDS (`configGet` | `configList` | `configSet`).
 * @param {{list?: Function}} [deps] Injectable catalog page reader.
 * @returns {Promise<string>} The advertised wire name.
 * @throws {Error} if the binding is unknown or the tool is not advertised.
 */
export async function resolveServerToolName(site, binding, { list = listServerTools } = {}) {
  const id = new Map(Object.entries(SERVER_TOOL_IDS)).get(binding);
  if (!id) throw new Error(`Unknown server tool binding "${binding}".`);
  const candidates = serverToolCandidates(id);
  const advertised = await advertisedServerToolNames(site, list);
  const name = candidates.find((candidate) => advertised.has(candidate));
  if (!name) {
    throw new Error(
      `Server tool "${id}" is not advertised by the source for site "${site._name}" ` +
      `(looked for ${candidates.join(" and ")} in tools/list). No call was made. ` +
      "Register and enable it as an mcp_tool_config entity, check that this account holds the scope the tool requires, " +
      "or map it under serverTools.bindings. See docs/integration-contract.md."
    );
  }
  return name;
}

/**
 * Call a governed config tool by the wire name the source advertises for it.
 * @param {object} site Resolved site config.
 * @param {string} binding Key of SERVER_TOOL_IDS.
 * @param {object} [args] Tool arguments.
 * @returns {Promise<*>} The tool's structured result.
 * @throws {Error} if the tool is not advertised, or as callServerTool.
 */
export async function callGovernedServerTool(site, binding, args = {}) {
  return callServerTool(site, await resolveServerToolName(site, binding), args);
}

/** MCP protocol version advertised on the handshake and every subsequent POST. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** MCP server-tool POST timeout. Handshake, catalog, and tools/call share this. */
export const SERVER_TOOL_TIMEOUT_MS = 15_000;

/** Default MCP response body cap (bytes). Caller `maxBytes` overrides. */
export const SERVER_TOOL_MAX_BYTES = 262_144;

// Monotonic JSON-RPC request id. A simple counter keeps ids unique per process
// without relying on Math.random()/Date.now().
let rpcId = 0;

/**
 * MCP session cache, keyed by site, endpoint, credentials and principal. Holds the `Mcp-Session-Id`
 * issued by the server's `initialize` response; cleared and re-acquired when the
 * server reports the session is gone (expiry).
 */
const sessions = new Map();
// Ephemeral cache identity only, never a persisted password verifier. A keyed
// digest also prevents offline guessing if a diagnostic exposes a cache key.
const sessionIdentityKey = randomBytes(32);

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
    ...northboundHeaders(),
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
 * Message for a non-2xx bridge response.
 *
 * The body is untrusted: an HTML error page from Drupal, PHP or a proxy, a
 * server path or a backtrace. Only a cleaned, bounded detail is shown (see
 * `describeErrorBody`). The prefix holds the HTTP status and always ends with a
 * colon — the documented message shape (`httpStatusOf`, and
 * `classifyBridgeError` when the error has no marker).
 *
 * A body that is a JSON-RPC error keeps its integer code and its cleaned
 * message, so a refusal sent with a 401 or 403 stays readable.
 * @param {string} prefix Message start, e.g. "Server-tool call x failed 502".
 * @param {object} res node-fetch Response with `ok === false`.
 * @param {string} rawText Response body.
 * @param {?object} body Parsed JSON-RPC body, if any.
 * @returns {string} Bounded message.
 */
function failedResponseMessage(prefix, res, rawText, body) {
  const rpcError = body?.error;
  if (rpcError && typeof rpcError === "object") {
    const code = Number.isInteger(rpcError.code) ? ` ${rpcError.code}` : "";
    const message = cleanErrorText(rpcError.message) || "the server returned no error message";
    return `${prefix}: JSON-RPC error${code}: ${message}`;
  }
  const detail = describeErrorBody(rawText, res.headers?.get?.("content-type") ?? null);
  return `${prefix}: ${detail || "the server returned an empty body"}`;
}

/**
 * Message for a JSON-RPC `error` object.
 *
 * `error.code` is kept when it is an integer, because callers read it.
 * `error.message` is cleaned and bounded. `error.data` is never read: with
 * verbose errors on it holds a backtrace.
 * @param {string} subject Message start, e.g. "Server-tool x".
 * @param {*} rpcError JSON-RPC error object from the response.
 * @returns {string} Bounded message.
 */
function rpcErrorMessage(subject, rpcError) {
  const code = Number.isInteger(rpcError?.code) ? ` (${rpcError.code})` : "";
  const detail = cleanErrorText(rpcError?.message) || "the server returned no error message";
  return `${subject} error${code}: ${detail}`;
}

/**
 * Build a bridge error that says what failed.
 *
 * The message ends with a response body or tool text, so code that branches on
 * the failure reads these properties, never the message (#361):
 *  - `bridgeFailure`: `"session"` (the handshake failed; no tool was reached),
 *    `"http"` (non-2xx on the request), `"rpc"` (JSON-RPC error object) or
 *    `"tool"` (the tool ran and its result has `isError`);
 *  - `status`: the HTTP status, on a non-2xx response only (see `httpStatusOf`);
 *  - `rpcCode`: the JSON-RPC `error.code`, when it is an integer.
 * @param {string} message Error message.
 * @param {"session"|"http"|"rpc"|"tool"} failure What failed.
 * @param {{status?: number, rpcCode?: *}} [facts] Response status or JSON-RPC code.
 * @returns {Error} The marked error.
 */
function bridgeError(message, failure, { status, rpcCode } = {}) {
  const error = new Error(message);
  error.bridgeFailure = failure;
  if (Number.isInteger(status)) error.status = status;
  if (Number.isInteger(rpcCode)) error.rpcCode = rpcCode;
  return error;
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
async function initializeSession(site, endpoint, key) {
  const payload = {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { prompts: {} },
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    },
  };

  const post = async () =>
    fetch(endpoint, {
      method: "POST",
      headers: await baseHeaders(site, null),
      body: JSON.stringify(payload),
      size: SERVER_TOOL_MAX_BYTES,
      signal: AbortSignal.timeout(SERVER_TOOL_TIMEOUT_MS),
    });

  let res = await post();
  if (res.status === 401 && site.oauth) {
    clearToken(site);
    res = await post();
  }

  const { body, rawText } = await readBody(res);
  if (!res.ok) {
    throw bridgeError(
      failedResponseMessage(`Server-tool session initialize failed ${res.status}`, res, rawText, body),
      "session",
      { status: res.status },
    );
  }
  if (body?.error) {
    throw bridgeError(rpcErrorMessage("Server-tool session initialize", body.error), "session", { rpcCode: body.error?.code });
  }

  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) {
    throw bridgeError(
      `Server-tool session initialize for site "${site._name}" returned no Mcp-Session-Id header.`,
      "session",
    );
  }

  // Best-effort: the server may not require notifications/initialized, and a
  // non-2xx here must not fail the call. Errors are swallowed deliberately.
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: await baseHeaders(site, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      size: SERVER_TOOL_MAX_BYTES,
      signal: AbortSignal.timeout(SERVER_TOOL_TIMEOUT_MS),
    });
  } catch {
    // Notification is advisory; proceed with the established session.
  }

  if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
  sessions.set(key, sessionId);
  return sessionId;
}

/**
 * Return the cached session id for a site, initialising one if absent.
 * @param {object} site Resolved site config.
 * @param {string} endpoint Fully-qualified endpoint URL.
 * @returns {Promise<string>} The active MCP session id.
 */
async function ensureSession(site, endpoint, key) {
  const cached = sessions.get(key);
  return cached || initializeSession(site, endpoint, key);
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
 * @param {string} toolName Server-side MCP wire name (see resolveServerToolName).
 * @param {object} [args] Tool arguments object.
 * @returns {Promise<*>} The tool's structured result.
 * @throws {Error} on transport failure, JSON-RPC error, or tool error.
 */
export async function callServerTool(site, toolName, args = {}, options = {}) {
  return requestServerTool(site, "tools/call", { name: toolName, arguments: args }, options);
}

/** Fetch one page of the authenticated module tool catalog. */
export async function listServerTools(site, cursor) {
  return requestServerTool(site, "tools/list", cursor === undefined ? {} : { cursor }, {
    maxBytes: SERVER_TOOL_MAX_BYTES, preserveErrors: true,
  });
}

/** Fetch one page of Drupal `McpPromptConfig` prompts. */
export async function listServerPrompts(site, cursor) {
  return requestServerTool(site, "prompts/list", cursor === undefined ? {} : { cursor }, {
    maxBytes: SERVER_TOOL_MAX_BYTES, preserveErrors: true,
  });
}

/**
 * Fetch one Drupal prompt body. Pass no arguments so `{{token}}` placeholders
 * stay intact for the connector's workflow renderer.
 */
export async function getServerPrompt(site, name) {
  return requestServerTool(site, "prompts/get", { name, arguments: {} }, {
    maxBytes: SERVER_TOOL_MAX_BYTES, preserveErrors: true,
  });
}

/**
 * Page `prompts/list` the same way as `tools/list`.
 * @param {object} site Resolved site config.
 * @param {Function} [list] Catalog page reader.
 * @returns {Promise<object[]>} Prompt descriptors.
 */
export async function advertisedServerPrompts(site, list = listServerPrompts) {
  const prompts = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    const result = await list(site, cursor);
    if (!Array.isArray(result?.prompts)) {
      throw new Error(`Server-tool catalog for site "${site._name}" is malformed: prompts/list returned no prompts array.`);
    }
    for (const prompt of result.prompts) {
      if (prompt && typeof prompt.name === "string") prompts.push(prompt);
    }
    if (result.nextCursor === undefined || result.nextCursor === null) return prompts;
    if (typeof result.nextCursor !== "string" || seen.has(result.nextCursor)) {
      throw new Error(`Server-tool catalog for site "${site._name}" returned an invalid or repeated prompts cursor.`);
    }
    cursor = result.nextCursor;
    seen.add(cursor);
  }
  throw new Error(`Server-tool catalog for site "${site._name}" exceeds ${MAX_CATALOG_PAGES} prompt pages.`);
}

/**
 * Load listed prompt descriptors plus `prompts/get` bodies for the named ids.
 * A get failure omits that id; the caller fail-closes rather than widening.
 * @param {object} site Resolved site config.
 * @param {string[]} names Workflow ids to fetch.
 * @param {{list?: Function, get?: Function}} [deps]
 * @returns {Promise<{list: object[], bodies: Map<string, object>}>}
 */
export async function fetchSiteWorkflowPrompts(site, names, { list = listServerPrompts, get = getServerPrompt } = {}) {
  const listed = await advertisedServerPrompts(site, list);
  const want = new Set(names ?? []);
  const bodies = new Map();
  for (const prompt of listed) {
    if (!want.has(prompt.name)) continue;
    try {
      bodies.set(prompt.name, await get(site, prompt.name));
    } catch {
      // Fail closed for this id: no body, so the merge will not list it.
    }
  }
  return { list: listed, bodies };
}

/** Shared bounded MCP request transport; size + abort are always attached. */
async function requestServerTool(site, method, params, options) {
  const toolName = params.name ?? method;
  const endpoint = resolveEndpoint(site);
  const payload = {
    jsonrpc: "2.0",
    id: ++rpcId,
    method,
    params,
  };

  const sessionKey = createHmac("sha256", sessionIdentityKey).update(JSON.stringify([
    site._name, endpoint, await authHeadersAsync(site), getDataFlowContext()?.principalKey ?? null,
  ])).digest("hex");
  let sessionId = await ensureSession(site, endpoint, sessionKey);
  let refreshedAuth = false;
  let reinitedSession = false;
  let paid = false;

  // Retry loop: at most one auth refresh and one session re-init, each replayed once.
  while (true) {
    consumeBudgetIfEnforced("request", 1, { retry: paid });
    paid = true;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: await baseHeaders(site, sessionId),
      body: JSON.stringify(payload),
      size: options.maxBytes ?? SERVER_TOOL_MAX_BYTES,
      signal: AbortSignal.timeout(SERVER_TOOL_TIMEOUT_MS),
    });
    const { body, rawText } = await readBody(res);

    // OAuth sites: a 401 may mean the token expired server-side. Refresh once.
    if (res.status === 401 && site.oauth && !refreshedAuth && options.retryRejected !== false) {
      refreshedAuth = true;
      clearToken(site);
      continue;
    }

    // Session expired/unknown: re-initialise once and replay.
    if (isSessionError(res, body) && !reinitedSession && options.retryRejected !== false) {
      reinitedSession = true;
      sessions.delete(sessionKey);
      sessionId = await ensureSession(site, endpoint, sessionKey);
      continue;
    }

    if (!res.ok) {
      const mapped = sourceBudgetDenial(rawText);
      if (mapped) throw mapped;
      throw bridgeError(
        failedResponseMessage(`Server-tool call ${toolName} failed ${res.status}`, res, rawText, body),
        "http",
        { status: res.status },
      );
    }

    // JSON-RPC transport-level error.
    if (body?.error) {
      throw bridgeError(rpcErrorMessage(`Server-tool ${toolName}`, body.error), "rpc", { rpcCode: body.error?.code });
    }

    // MCP tools/call result: { content: [...], isError?: boolean }.
    const result = body?.result;
    if (result?.isError && !options.preserveErrors) {
      // The budget code is looked for in the whole text, before it is cut.
      const text = extractTextContent(result);
      const mapped = sourceBudgetDenial(text);
      if (mapped) throw mapped;
      // The tool's own words are for the caller (a governed refusal explains
      // itself), so they are kept: cleaned and bounded, never relayed raw.
      const detail = cleanErrorText(text) || "tool reported an error";
      throw bridgeError(`Server-tool ${toolName} reported an error: ${detail}`, "tool");
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
