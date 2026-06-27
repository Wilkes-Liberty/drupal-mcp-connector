/**
 * Server-tool bridge — call governed MCP tools exposed by Drupal.
 *
 * The connector itself is an MCP *server* for the AI client. For governed
 * configuration operations, Drupal exposes its own MCP tools server-side
 * (the `mcp_server_tool_bridge` / `mcp_sentinel` modules). This module makes
 * the connector an MCP *client* of that server so config get/list/set are
 * mediated by Drupal's authoritative governance layer rather than by drush.
 *
 * Transport: JSON-RPC 2.0 over HTTPS POST to the per-site `serverTools.url`
 * endpoint, authenticated with the same OAuth bearer used for JSON:API. The
 * endpoint path is configurable so it tracks whatever route the Drupal-side
 * bridge publishes.
 *
 * Config (per site):
 *   "serverTools": { "url": "/mcp" }   // path is resolved against site.baseUrl
 *
 * Tools are NOT functional until the Drupal-side governed config tools ship;
 * until then the server returns a tool-not-found error, surfaced verbatim.
 */

import fetch from "node-fetch";
import { authHeadersAsync, clientHeaders } from "./config.js";
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
};

// Monotonic JSON-RPC request id. A simple counter keeps ids unique per process
// without relying on Math.random()/Date.now().
let rpcId = 0;

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
 * Call a governed MCP tool on the Drupal server via JSON-RPC `tools/call`.
 *
 * For OAuth2 sites a 401 triggers a single retry: the cached token is cleared,
 * re-acquired, and the request replayed once (mirrors drupalFetch).
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

  async function attempt() {
    return fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...clientHeaders(),
        ...(await authHeadersAsync(site)),
      },
      body: JSON.stringify(payload),
    });
  }

  let res = await attempt();

  // OAuth sites: a 401 may mean the token expired server-side. Refresh once.
  if (res.status === 401 && site.oauth) {
    clearToken(site);
    res = await attempt();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Server-tool call ${toolName} failed ${res.status}: ${text}`);
  }

  const body = await res.json();

  // JSON-RPC transport-level error.
  if (body.error) {
    const { code, message } = body.error;
    const hasCode = code !== undefined && code !== null;
    throw new Error(`Server-tool ${toolName} error${hasCode ? ` (${code})` : ""}: ${message}`);
  }

  // MCP tools/call result: { content: [...], isError?: boolean }.
  const result = body.result;
  if (result?.isError) {
    const detail = extractTextContent(result) || "tool reported an error";
    throw new Error(`Server-tool ${toolName} reported an error: ${detail}`);
  }
  return result;
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
