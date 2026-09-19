import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sites: [], reply: null, catalog: null }));
vi.mock("node-fetch", () => ({ default: vi.fn() }));
vi.mock("../../src/lib/config.js", async (original) => ({
  ...await original(),
  getSiteConfig: vi.fn((name) => state.sites.find((s) => s._name === name)),
  listSiteNames: vi.fn(() => state.sites.map((s) => s._name)),
  getInboundGrants: () => null,
  getDefaultSiteName: () => "stage",
}));
vi.mock("../../src/lib/governance.js", async (original) => ({
  ...await original(), assertSourceGovernance: vi.fn(async () => {}),
}));
import fetch from "node-fetch";
import { assertSourceGovernance } from "../../src/lib/governance.js";
import { createModuleToolRegistry } from "../../src/lib/module-tools.js";
import { resetDataFlowBudgets } from "../../src/lib/data-flow.js";
import { ERROR_DETAIL_MAX_CHARS } from "../../src/lib/error-body.js";

/**
 * A module tool's failure is relayed (`preserveErrors`): the module's message
 * is application data the caller needs. It is still untrusted text, so it is
 * cleaned and bounded. A transport failure is never relayed at all (#362).
 *
 * These tests use the real bridge client over a scripted `fetch`.
 */

const SERVER_PATH = "/var/www/html/web/modules/custom/crm/src/Plugin/tool/OpportunityTransition.php";
const TRACE = `Stack trace: #0 ${SERVER_PATH}(120): Drupal\\crm\\Transition->apply() #1 {main}`;
const HTML_PAGE = "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1>nginx/1.25.3</body></html>";

const schema = { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "integer" } } };
const outputSchema = { type: "object", additionalProperties: true };

const mcpRes = ({ status = 200, sessionId = null, json, text, contentType = "application/json" } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => ({ "mcp-session-id": sessionId, "content-type": contentType })[String(h).toLowerCase()] ?? null },
  text: async () => (text !== undefined ? text : json !== undefined ? JSON.stringify(json) : ""),
});
const rpcResult = (result) => mcpRes({ json: { jsonrpc: "2.0", id: 1, result } });

let siteSeq = 0;
let registry;
beforeEach(() => {
  resetDataFlowBudgets();
  vi.clearAllMocks();
  vi.mocked(assertSourceGovernance).mockResolvedValue();
  // A fresh site name per test keeps the bridge's session cache from leaking.
  state.sites = [{
    _name: `stage-${++siteSeq}`, baseUrl: "https://stage.example.com", requireGovernance: true,
    security: { preset: "development", readOnly: false },
    serverTools: { url: "/mcp", modules: { namespace: `ns${siteSeq}`, tools: {
      transition: { name: "tool_api.transition", operation: "write", scope: "module_access", capabilities: [] },
    } } },
  }];
  state.catalog = rpcResult({ tools: [{ name: "tool_api.transition", inputSchema: schema, outputSchema }] });
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    const { method } = JSON.parse(options.body);
    if (method === "initialize") return mcpRes({ sessionId: "s", json: { jsonrpc: "2.0", id: 1, result: {} } });
    if (method === "notifications/initialized") return mcpRes({ status: 202, text: "" });
    if (method === "tools/list") return state.catalog;
    return state.reply;
  });
  registry = createModuleToolRegistry();
});

const context = () => ({ sites: state.sites, identity: { scopes: ["module_access"], sites: [state.sites[0]._name] } });
const invoke = async () => {
  const [definition] = await registry.list(context());
  return registry.call(definition.name, {
    catalogRevision: definition.inputSchema.properties.catalogRevision.const, arguments: { id: 17 },
  }, context());
};

/** What no relayed failure may hold. */
const expectClean = (result) => {
  const serialized = JSON.stringify(result);
  expect(serialized).not.toMatch(/<\/?[a-z]/i);
  expect(serialized).not.toContain("/var/www");
  expect(serialized).not.toContain("OpportunityTransition.php");
  expect(serialized).not.toMatch(/#0 |\{main\}/);
  expect(serialized).not.toContain("nginx/1.25.3");
};

describe("a module tool failure relayed by the registry", () => {
  it("keeps the module's own text, cleaned and bounded", async () => {
    const text = `<p>Opportunity 17 cannot move to won: amount is required.</p> Raised in ${SERVER_PATH} ${"X".repeat(20000)} ${TRACE}`;
    state.reply = rpcResult({ isError: true, content: [{ type: "text", text }] });
    const result = await invoke();
    expect(result.isError).toBe(true);
    const relayed = result.structuredContent.result;
    expect(relayed).toMatch(/^Opportunity 17 cannot move to won: amount is required\. Raised in \[path\]/);
    expect(relayed.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX_CHARS + 20);
    expectClean(result);
  });

  it("keeps a structured failure usable: keys, codes and numbers stay, strings are cleaned", async () => {
    state.reply = rpcResult({ content: [], structuredContent: {
      success: false,
      code: "transition_denied",
      message: "Opportunity 17 cannot move to won: amount is required.",
      retryable: false,
      opportunity: 17,
      errors: [
        { field: "amount", message: `required <script>alert(1)</script> (validated in ${SERVER_PATH})` },
        { field: "stage", message: `invalid ${TRACE}` },
      ],
      debug: `${"Y".repeat(30000)}`,
    } });
    const result = await invoke();
    expect(result.isError).toBe(true);
    const relayed = result.structuredContent.result;
    expect(relayed).toMatchObject({
      success: false, code: "transition_denied", retryable: false, opportunity: 17,
      message: "Opportunity 17 cannot move to won: amount is required.",
    });
    expect(relayed.errors[0]).toEqual({ field: "amount", message: "required alert(1) (validated in [path])" });
    expect(relayed.errors[1]).toEqual({ field: "stage", message: "invalid [stack trace removed]" });
    expect(relayed.debug.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX_CHARS + 20);
    expectClean(result);
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("bounds a failure with very many or very deep entries", async () => {
    const deep = {};
    let cursor = deep;
    for (let i = 0; i < 40; i++) { cursor.next = { note: `level ${i} ${SERVER_PATH}` }; cursor = cursor.next; }
    state.reply = rpcResult({ content: [], structuredContent: {
      success: false, message: "bulk transition failed",
      errors: Array.from({ length: 500 }, (_, i) => `row ${i}: ${"Z".repeat(300)}`),
      deep,
    } });
    const result = await invoke();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.result.message).toBe("bulk transition failed");
    expect(JSON.stringify(result.structuredContent.result).length).toBeLessThan(12000);
    expectClean(result);
  });

  it("does not alter a successful result", async () => {
    const data = { id: 17, note: `<b>stored</b> at ${SERVER_PATH}` };
    state.reply = rpcResult({ content: [], structuredContent: data });
    const result = await invoke();
    expect(result.isError).toBe(false);
    expect(result.structuredContent.result).toEqual(data);
  });
});

describe("a transport failure behind the registry", () => {
  it.each([
    ["an HTML error page", () => mcpRes({ status: 502, text: HTML_PAGE, contentType: "text/html" })],
    ["a JSON body with a server path", () => mcpRes({ status: 500, json: { message: `Cannot write ${SERVER_PATH}` } })],
    ["a JSON-RPC error", () => mcpRes({ json: { jsonrpc: "2.0", id: 1, error: { code: -32603, message: `boom in ${SERVER_PATH} ${TRACE}` } } })],
  ])("never relays %s", async (_label, reply) => {
    state.reply = reply();
    const result = await invoke();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: Module tool unavailable or returned an invalid response. No fallback was attempted.");
    expectClean(result);
  });

  it("gives a compatibility binding a fixed refusal, with none of the module's text", async () => {
    const site = state.sites[0];
    site.serverTools.bindings = { moveStage: "transition" };
    const required = { operation: "write", scope: "module_access", capabilities: [] };
    for (const reply of [
      rpcResult({ isError: true, content: [{ type: "text", text: `<p>denied</p> ${SERVER_PATH} ${TRACE}` }] }),
      mcpRes({ status: 502, text: HTML_PAGE, contentType: "text/html" }),
    ]) {
      state.reply = reply;
      await expect(registry.callBinding(site, "moveStage", { id: 17 }, required, context()))
        .rejects.toThrow("Bound module tool refused the request; no fallback was attempted.");
    }
  });
});
