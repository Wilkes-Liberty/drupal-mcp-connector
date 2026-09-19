import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ site: null, reply: null, catalog: [], connect: vi.fn() }));
vi.mock("node-fetch", () => ({ default: vi.fn() }));
vi.mock("../../src/lib/config.js", async (original) => ({
  ...await original(),
  getSiteConfig: () => state.site,
  listSiteNames: () => [state.site._name],
  getInboundGrants: () => null,
  getDefaultSiteName: () => state.site._name,
}));
vi.mock("../../src/lib/governance.js", async (original) => ({
  ...await original(), assertSourceGovernance: vi.fn(async () => {}),
}));
vi.mock("ssh2", () => ({ Client: class { connect = state.connect; } }));

import fetch from "node-fetch";
import { handlers as config } from "../../src/tools/config.js";
import { handlers as codegen } from "../../src/tools/codegen.js";
import { handlers as drush } from "../../src/tools/drush.js";
import { SecurityError } from "../../src/lib/security.js";
import { resetDataFlowBudgets } from "../../src/lib/data-flow.js";

/**
 * The compatibility tools (config, Codegen, raw SQL) call the bridge. None of
 * them reads the bridge's error text, so cleaning it (#362) changes no branch.
 * These tests pin that: each tool still fails the way it did, and what reaches
 * the client holds no response body. They use the real bridge client over a
 * scripted `fetch`.
 */

const SERVER_PATH = "/var/www/html/web/modules/contrib/mcp_sentinel/src/Plugin/tool/McpConfigGet.php";
const TRACE = `Stack trace: #0 ${SERVER_PATH}(41): Drupal\\Core\\Config\\ConfigFactory->get() #1 {main}`;
const HTML_PAGE =
  "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1>" +
  `<pre>${TRACE}</pre>nginx/1.25.3</body></html>`;

const mcpRes = ({ status = 200, sessionId = null, json, text, contentType = "application/json" } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => ({ "mcp-session-id": sessionId, "content-type": contentType })[String(h).toLowerCase()] ?? null },
  text: async () => (text !== undefined ? text : json !== undefined ? JSON.stringify(json) : ""),
});
const rpcResult = (result) => mcpRes({ json: { jsonrpc: "2.0", id: 1, result } });
const htmlFailure = () => mcpRes({ status: 502, text: HTML_PAGE, contentType: "text/html" });
const toolFailure = () => rpcResult({ isError: true, content: [{ type: "text", text: `<p>denied</p> in ${SERVER_PATH} ${TRACE}` }] });

const anySchema = { type: "object" };
const advertise = (...names) => names.map((name) => ({ name, inputSchema: anySchema, outputSchema: anySchema }));

let siteSeq = 0;
beforeEach(() => {
  vi.clearAllMocks();
  resetDataFlowBudgets();
  // A fresh site name per test keeps the bridge's session cache from leaking.
  state.site = {
    _name: `dev-${++siteSeq}`, baseUrl: "https://dev.example.com",
    security: { preset: "development" }, serverTools: { url: "/mcp" }, drushSsh: { rawSql: "governed" },
  };
  state.catalog = advertise("tool_api__mcp_sentinel_config_get", "tool_api__mcp_sentinel_config_set");
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "initialize") return mcpRes({ sessionId: "s", json: { jsonrpc: "2.0", id: 1, result: {} } });
    if (body.method === "notifications/initialized") return mcpRes({ status: 202, text: "" });
    if (body.method === "tools/list") return rpcResult({ tools: state.catalog });
    return typeof state.reply === "function" ? state.reply(body) : state.reply;
  });
});

/** What no tool error may hold. */
const expectClean = (message) => {
  expect(message).not.toMatch(/[<>]/);
  expect(message).not.toContain("/var/www");
  expect(message).not.toContain("McpConfigGet.php");
  expect(message).not.toMatch(/#0 |\{main\}/);
  expect(message).not.toContain("nginx/1.25.3");
  expect(message.length).toBeLessThan(1200);
};
const failure = (promise) => promise.then(() => { throw new Error("expected a failure"); }, (error) => error);

describe("config tools without bindings", () => {
  it("reports a failed read with its status and no response body", async () => {
    state.reply = htmlFailure();
    const error = await failure(config.drupal_config_get({ name: "system.site" }));
    expect(error.message).toMatch(/^Server-tool call tool_api__mcp_sentinel_config_get failed 502: /);
    expectClean(error.message);
  });

  it("keeps the source's refusal of a write readable", async () => {
    const refusal = "denied by MCP Sentinel policy: system.site is not in the writable allowlist";
    state.reply = rpcResult({ isError: true, content: [{ type: "text", text: refusal }] });
    const error = await failure(config.drupal_config_set({ name: "system.site", value: { name: "X" } }));
    expect(error.message).toBe(`Server-tool tool_api__mcp_sentinel_config_set reported an error: ${refusal}`);
  });

  it("refuses a core.extension write whose module list cannot be read, with a clean reason", async () => {
    state.site.security = { preset: "development", allowCoreExtensionChange: true };
    const written = [];
    state.reply = (body) => {
      if (body.params.name.endsWith("config_set")) { written.push(body); return rpcResult({ content: [] }); }
      return htmlFailure();
    };
    const error = await failure(config.drupal_config_set({ name: "core.extension", value: { module: { node: 0 } } }));
    expect(error).toBeInstanceOf(SecurityError);
    expect(error.message).toMatch(/could not be read/);
    expect(error.message).toMatch(/Reason: Server-tool call tool_api__mcp_sentinel_config_get failed 502: /);
    expectClean(error.message);
    expect(written).toEqual([]);
  });
});

describe("tools behind a module binding", () => {
  const bind = (binding, name, scope, capabilities) => {
    const alias = binding.toLowerCase();
    state.site.serverTools.bindings = { ...(state.site.serverTools.bindings ?? {}), [binding]: alias };
    state.site.serverTools.modules ??= { namespace: `ns${siteSeq}`, tools: {} };
    state.site.serverTools.modules.tools[alias] = { name, operation: "read", scope, capabilities };
    state.catalog = [...state.catalog, ...advertise(name)];
  };

  it.each([["an HTML error page", htmlFailure], ["a tool failure", toolFailure]])(
    "gives config, Codegen and SQL a fixed refusal on %s", async (_label, reply) => {
      bind("configGet", "tool_api__config_read", "mcp_config", ["configRead"]);
      bind("codegenInspect", "tool_api__codegen_inspect", "mcp_config", ["configRead"]);
      bind("sqlQuery", "tool_api__sql_query", "mcp_admin", ["rawSql"]);
      state.reply = reply();
      for (const call of [
        () => config.drupal_config_get({ name: "system.site" }),
        () => codegen.drupal_codegen_inspect({}),
        () => drush.drupal_drush_sql_query({ query: "SELECT nid FROM node_field_data" }),
      ]) {
        const error = await failure(call());
        expect(error).toBeInstanceOf(SecurityError);
        expect(error.message).toBe("Bound module tool refused the request; no fallback was attempted.");
      }
      expect(state.connect).not.toHaveBeenCalled();
    },
  );
});
