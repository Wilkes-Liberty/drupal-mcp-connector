import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ site: null, call: vi.fn(), connect: vi.fn() }));
vi.mock("../../src/lib/config.js", () => ({ getSiteConfig: () => state.site }));
vi.mock("../../src/lib/server-tools.js", () => ({
  callBoundModuleTool: state.call,
  toolResultData: (result) => result.structuredContent,
}));
vi.mock("ssh2", () => ({ Client: class { connect = state.connect; } }));

import { handlers as codegen } from "../../src/tools/codegen.js";
import { handlers as drush } from "../../src/tools/drush.js";

beforeEach(() => {
  vi.clearAllMocks();
  state.site = {
    _name: "staging", security: { preset: "development" },
    serverTools: { bindings: {} }, drushSsh: { rawSql: "governed" },
  };
});

function reply(data) {
  state.call.mockResolvedValue({ structuredContent: { success: true, data } });
}

describe("module-owned compatibility commands", () => {
  it.each([
    ["inspect", "codegenInspect"], ["diff", "codegenDiff"], ["generate", "codegenPreview"],
  ])("routes Codegen %s through its configured binding without SSH", async (operation, binding) => {
    reply({ artefacts: { "example.ts": "export type Example = string;" } });
    const result = await codegen[`drupal_codegen_${operation}`]({
      bundles: ["article"], skipFields: ["field_secret"],
    });
    expect(state.call).toHaveBeenCalledWith(state.site, binding, {
      bundles: ["article"], skip_fields: ["field_secret"],
    }, { operation: "read", scope: "mcp_config", capabilities: ["configRead"] });
    expect(result.wroteFiles).toBe(false);
    expect(result.command).toBe(`module:${binding}`);
    expect(JSON.parse(result.output).artefacts["example.ts"]).toContain("Example");
    expect(state.connect).not.toHaveBeenCalled();
  });

  it("keeps the SQL result shape and requires the explicit raw SQL contract", async () => {
    const data = { rows: [{ nid: 1 }], row_count: 1, truncated: false, profile: "fixture" };
    reply(data);
    expect(await drush.drupal_drush_sql_query({ query: "SELECT nid FROM node_field_data" })).toEqual(data);
    expect(state.call).toHaveBeenCalledWith(state.site, "sqlQuery", { query: "SELECT nid FROM node_field_data" }, {
      operation: "read", scope: "mcp_admin", capabilities: ["rawSql"],
    });
    expect(state.connect).not.toHaveBeenCalled();
  });

  it("refuses SQL without local opt-in before contacting the module", async () => {
    state.site.drushSsh.rawSql = "off";
    await expect(drush.drupal_drush_sql_query({ query: "SELECT nid FROM node_field_data" })).rejects.toThrow();
    expect(state.call).not.toHaveBeenCalled();
    expect(state.connect).not.toHaveBeenCalled();
  });

  it("refuses writes before either transport", async () => {
    await expect(drush.drupal_drush_sql_query({ query: "DELETE FROM node_field_data" })).rejects.toThrow(/SELECT/);
    expect(state.call).not.toHaveBeenCalled();
    expect(state.connect).not.toHaveBeenCalled();
  });

  it.each(["codegen", "sql"])("never falls back after a missing or refused %s binding", async (kind) => {
    state.call.mockRejectedValue(new Error("Bound module tool is unavailable for this caller."));
    const invoke = kind === "codegen" ? codegen.drupal_codegen_inspect({})
      : drush.drupal_drush_sql_query({ query: "SELECT nid FROM node_field_data" });
    await expect(invoke).rejects.toThrow(/unavailable/);
    expect(state.connect).not.toHaveBeenCalled();
  });

  it.each([null, [], { success: false, data: { rows: [] } }, { success: true, data: "bad" }])(
    "refuses malformed or failed module envelopes", async (structuredContent) => {
      state.call.mockResolvedValue({ structuredContent });
      await expect(codegen.drupal_codegen_inspect({})).rejects.toThrow(/invalid result/);
      await expect(drush.drupal_drush_sql_query({ query: "SELECT nid FROM node_field_data" })).rejects.toThrow(/invalid governed result/);
      expect(state.connect).not.toHaveBeenCalled();
    },
  );
});
