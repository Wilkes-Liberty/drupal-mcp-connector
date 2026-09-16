import { beforeEach, describe, expect, it, vi } from "vitest";
import Ajv from "ajv/dist/2020.js";

const state = vi.hoisted(() => ({ sites: [] }));
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
import { assertSourceGovernance } from "../../src/lib/governance.js";
import { createModuleToolRegistry } from "../../src/lib/module-tools.js";
import { resetDataFlowBudgets } from "../../src/lib/data-flow.js";

const schema = {
  type: "object", required: ["id"], additionalProperties: false,
  $defs: { identifier: { type: "integer", minimum: 1 } },
  properties: { id: { $ref: "#/$defs/identifier" } },
};
const remote = (name) => ({ name, inputSchema: schema, outputSchema: schema });
const rule = (name, operation = "read") => ({ name, operation, scope: "module_access", capabilities: [] });
let list, call, registry;
beforeEach(() => {
  resetDataFlowBudgets();
  vi.clearAllMocks();
  vi.mocked(assertSourceGovernance).mockResolvedValue();
  state.sites = [{
    _name: "stage", baseUrl: "https://stage.example.com", requireGovernance: true,
    security: { preset: "development", readOnly: false },
    serverTools: { url: "/mcp", modules: { namespace: "stage", tools: {
      relationship: rule("tool_api.relationship"), asset: rule("tool_api.asset", "write"),
    } } },
  }];
  list = vi.fn(async () => ({ tools: [remote("tool_api.relationship"), remote("tool_api.asset")] }));
  call = vi.fn(async (_site, _name, args) => ({ content: [], structuredContent: args }));
  registry = createModuleToolRegistry({ list, call });
});
const context = () => ({ sites: state.sites, identity: { scopes: ["module_access"], sites: ["stage"] } });
const parameters = (definition, args = { id: 1 }) => ({
  catalogRevision: definition.inputSchema.properties.catalogRevision.const, arguments: args,
});

describe("module-owned tool registry", () => {
  it("routes a configured compatibility binding through the module contract", async () => {
    const site = state.sites[0];
    site.serverTools.bindings = { readRecord: "relationship" };
    const result = await registry.callBinding(site, "readRecord", { id: 1 }, {
      operation: "read", scope: "module_access", capabilities: [],
    }, context());
    expect(result.structuredContent).toEqual({ id: 1 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][1]).toBe("tool_api.relationship");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("refuses missing bindings and insufficient configured capability contracts", async () => {
    const site = state.sites[0];
    const required = { operation: "read", scope: "module_access", capabilities: ["configRead"] };
    await expect(registry.callBinding(site, "readRecord", {}, required, context())).rejects.toThrow(/binding/);
    site.serverTools.bindings = { readRecord: "relationship" };
    await expect(registry.callBinding(site, "readRecord", {}, required, context())).rejects.toThrow(/contract/);
    await expect(registry.callBinding(site, "readRecord", {}, { ...required, capabilities: [], operation: "write" }, context())).rejects.toThrow(/contract/);
    await expect(registry.callBinding(site, "readRecord", {}, { ...required, capabilities: [], scope: "another_scope" }, context())).rejects.toThrow(/contract/);
    expect(list).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("refuses a binding removed after discovery without calling a replacement", async () => {
    const site = state.sites[0];
    site.serverTools.bindings = { readRecord: "relationship" };
    list.mockResolvedValueOnce({ tools: [remote("tool_api.relationship")] }).mockResolvedValue({ tools: [] });
    await expect(registry.callBinding(site, "readRecord", { id: 1 }, {
      operation: "read", scope: "module_access", capabilities: [],
    }, context())).rejects.toThrow(/no fallback/);
    expect(call).not.toHaveBeenCalled();
  });

  it("retains caller scope and target grants when a compatibility binding is used", async () => {
    const site = state.sites[0];
    site.serverTools.bindings = { readRecord: "relationship" };
    for (const identity of [{ scopes: [], sites: ["stage"] }, { scopes: ["module_access"], sites: ["other"] }]) {
      await expect(registry.callBinding(site, "readRecord", { id: 1 }, {
        operation: "read", scope: "module_access", capabilities: [],
      }, { ...context(), identity })).rejects.toThrow(/unavailable/);
    }
    expect(list).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("propagates source failure for a binding without treating it as success", async () => {
    const site = state.sites[0];
    site.serverTools.bindings = { readRecord: "relationship" };
    call.mockResolvedValue({ content: [], structuredContent: { success: false } });
    await expect(registry.callBinding(site, "readRecord", { id: 1 }, {
      operation: "read", scope: "module_access", capabilities: [],
    }, context())).rejects.toThrow(/refused/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("discovers and invokes unrelated providers without domain-specific handlers", async () => {
    const definitions = await registry.list(context());
    expect(definitions).toHaveLength(2);
    for (const definition of definitions) {
      const args = parameters(definition);
      expect(new Ajv({ strict: true }).compile(definition.inputSchema)(args)).toBe(true);
      const result = await registry.call(definition.name, args, context());
      expect(result.isError).toBe(false);
      expect(result.structuredContent.result).toEqual({ id: 1 });
      expect(result.structuredContent._target.name).toBe("stage");
      expect(new Ajv({ strict: true }).compile(definition.outputSchema)(result.structuredContent)).toBe(true);
    }
    expect(call.mock.calls.find((args) => args[1] === "tool_api.asset")[3].retryRejected).toBe(false);
  });

  it("accepts nullable composed types while enforcing every input constraint", async () => {
    const composed = {
      type: "object", required: ["id"], additionalProperties: false,
      properties: {
        id: { type: "integer", minimum: 1 },
        label: { oneOf: [{ type: "string" }, { type: "null" }], maxLength: 4 },
        count: { oneOf: [{ type: "integer" }, { type: "null" }], minimum: 1 },
      },
    };
    list.mockResolvedValue({ tools: [{ ...remote("tool_api.asset"), inputSchema: composed, outputSchema: composed }] });
    const definitions = await registry.list(context());
    expect(definitions).toHaveLength(1);
    const definition = definitions[0];
    for (const args of [{ id: 1 }, { id: 1, label: null, count: null }, { id: 1, label: "test", count: 2 }]) {
      const result = await registry.call(definition.name, parameters(definition, args), context());
      expect(result.isError).toBe(false);
      expect(result.structuredContent.result).toEqual(args);
    }
    call.mockClear();
    for (const args of [
      { id: 1, label: "longer" }, { id: 1, label: 2 },
      { id: 1, count: "2" }, { id: 1, count: 0 },
      { id: 1, count: 1.5 }, { id: 1, owner: 2 }, {},
    ]) {
      expect((await registry.call(definition.name, parameters(definition, args), context())).isError).toBe(true);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("denies discovery and direct calls for the wrong scope before source reads", async () => {
    const ctx = { ...context(), identity: { scopes: ["mcp_read"], sites: ["stage"] } };
    expect(await registry.list(ctx)).toEqual([]);
    expect((await registry.call("drupal_module_write_stage__asset", {}, ctx)).isError).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("does not leak a catalog across target grants", async () => {
    expect(await registry.list({ ...context(), identity: { scopes: ["module_access"], sites: ["other"] } })).toEqual([]);
    expect(list).not.toHaveBeenCalled();
  });

  it("uses operator operation policy, never remote read-only annotations", async () => {
    state.sites[0].security.readOnly = true;
    list.mockResolvedValue({ tools: [{ ...remote("tool_api.asset"), annotations: { readOnlyHint: true } }] });
    expect(await registry.list(context())).toEqual([]);
    expect((await registry.call("drupal_module_write_stage__asset", {}, context())).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("requires each configured capability even when the credential scope matches", async () => {
    const site = state.sites[0];
    site.security = { preset: "production-strict", readOnly: false };
    site.serverTools.modules.tools = { relationship: {
      ...rule("tool_api.relationship"), capabilities: ["configRead"],
    } };
    expect(await registry.list(context())).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    site.security.allowConfigRead = true;
    expect(await registry.list(context())).toHaveLength(1);
  });

  it("rejects excessive catalogs and externally resolved schemas", async () => {
    list.mockResolvedValue({ tools: Array.from({ length: 257 }, (_, index) => remote(`tool_api.item_${index}`)) });
    expect(await registry.list(context())).toEqual([]);
    list.mockResolvedValue({ tools: [{ ...remote("tool_api.relationship"), inputSchema: {
      type: "object", properties: { id: { $ref: "https://untrusted.example/schema" } },
    } }] });
    expect(await registry.list(context())).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects changed schemas and disabled tools after discovery", async () => {
    const [definition] = await registry.list(context());
    list.mockResolvedValue({ tools: [{ ...remote("tool_api.asset"), inputSchema: { type: "object" } }] });
    expect((await registry.call(definition.name, parameters(definition), context())).isError).toBe(true);
    list.mockResolvedValue({ tools: [] });
    expect((await registry.call(definition.name, parameters(definition), context())).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects coercion, extra routing hints and malformed output", async () => {
    const [definition] = await registry.list(context());
    for (const args of [parameters(definition, { id: "1" }), { ...parameters(definition), site: "prod" }]) {
      expect((await registry.call(definition.name, args, context())).isError).toBe(true);
    }
    expect(call).not.toHaveBeenCalled();
    call.mockResolvedValue({ content: [], structuredContent: { id: "wrong" } });
    expect((await registry.call(definition.name, parameters(definition), context())).isError).toBe(true);
  });

  it("requires source governance and never retains an unavailable catalog", async () => {
    const [definition] = await registry.list(context());
    vi.mocked(assertSourceGovernance).mockRejectedValue(new Error("not ready"));
    expect(await registry.list(context())).toEqual([]);
    expect((await registry.call(definition.name, parameters(definition), context())).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("follows an empty cursor and rejects repeated cursors atomically", async () => {
    list.mockResolvedValueOnce({ tools: [], nextCursor: "" }).mockResolvedValueOnce({ tools: [remote("tool_api.asset")] });
    expect(await registry.list(context())).toHaveLength(1);
    expect(list.mock.calls[1][1]).toBe("");
    list.mockResolvedValue({ tools: [], nextCursor: "again" });
    expect(await registry.list(context())).toEqual([]);
  });

  it("rejects duplicate remote names and colliding configured namespaces", async () => {
    list.mockResolvedValue({ tools: [remote("tool_api.asset"), remote("tool_api.asset")] });
    expect(await registry.list(context())).toEqual([]);
    state.sites.push({ ...state.sites[0], _name: "other" });
    await expect(registry.list(context())).rejects.toThrow("Duplicate");
  });

  it("isolates a malformed action schema from valid siblings", async () => {
    list.mockResolvedValue({ tools: [
      { ...remote("tool_api.relationship"), inputSchema: { type: "object", invalidKeyword: true } },
      remote("tool_api.asset"),
    ] });
    const definitions = await registry.list(context());
    expect(definitions.map((definition) => definition.name)).toEqual(["drupal_module_write_stage__asset"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect((await registry.call(definitions[0].name, parameters(definitions[0]), context())).isError).toBe(false);
  });

  it("preserves tool failure and refuses non-JSON attachments", async () => {
    const [definition] = await registry.list(context());
    call.mockResolvedValue({ content: [{ type: "text", text: "Denied" }], isError: true });
    expect((await registry.call(definition.name, parameters(definition), context())).isError).toBe(true);
    call.mockResolvedValue({ content: [{ type: "image", data: "private" }] });
    const result = await registry.call(definition.name, parameters(definition), context());
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
