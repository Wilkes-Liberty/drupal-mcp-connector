import { describe, it, expect, vi, beforeEach } from "vitest";

// Per-site fixtures keyed by name, so each test can pick a tier.
const SITES = {
  prod:  { _name: "prod",  oauth: { scopes: ["mcp_read", "mcp_write"] },              serverTools: { url: "/mcp" }, security: { preset: "content-editor" } },
  dev:   { _name: "dev",   oauth: { scopes: ["mcp_read", "mcp_write", "mcp_config"] }, serverTools: { url: "/mcp" }, security: { preset: "config-editor" } },
  admin: { _name: "admin", oauth: { scopes: ["mcp_read", "mcp_write", "mcp_config", "mcp_admin"] }, serverTools: { url: "/mcp" }, security: { preset: "development" } },
};

vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => SITES[n] ?? SITES.dev),
}));

// The unbound path resolves the wire name from the source catalog, so the
// tools hand over the binding key rather than a hard-coded wire name.
const callServerTool = vi.fn();
const callBoundModuleTool = vi.fn();
vi.mock("../../src/lib/server-tools.js", async (orig) => ({
  // toolResultData is the real parser: the core.extension check reads a result with it.
  toolResultData: (await orig()).toolResultData,
  callGovernedServerTool: (...args) => callServerTool(...args),
  callBoundModuleTool: (...args) => callBoundModuleTool(...args),
}));

import { handlers } from "../../src/tools/config.js";
import { SecurityError } from "../../src/lib/security.js";

beforeEach(() => {
  callServerTool.mockReset();
  callBoundModuleTool.mockReset();
});

describe("config tools — governed via server-tool bridge", () => {
  it("uses an explicit module binding without replaying failures through the legacy tool", async () => {
    SITES.dev.serverTools.bindings = { configSet: "approved_write" };
    vi.mocked(callBoundModuleTool).mockRejectedValue(new SecurityError("Refused"));
    try {
      await expect(handlers.drupal_config_set({ site: "dev", name: "system.site", value: { name: "X" } })).rejects.toThrow("Refused");
      expect(callBoundModuleTool).toHaveBeenCalledWith(SITES.dev, "configSet", { name: "system.site", data: { name: "X" } }, {
        operation: "write", scope: "mcp_config", capabilities: ["configWrite"],
      });
      expect(callServerTool).not.toHaveBeenCalled();
    } finally {
      delete SITES.dev.serverTools.bindings;
    }
  });

  it("config_get on a config tier (mcp_config) calls the server tool", async () => {
    callServerTool.mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    await handlers.drupal_config_get({ site: "dev", name: "system.site" });
    expect(callServerTool).toHaveBeenCalledWith(SITES.dev, "configGet", { name: "system.site" });
  });

  it("config_get is denied on the Content tier (no mcp_config scope)", async () => {
    // The content tier holds mcp_read/mcp_write but not mcp_config; every
    // config_* tool is gated on mcp_config server-side, so the connector must
    // refuse locally rather than dispatch a call the server will deny.
    await expect(handlers.drupal_config_get({ site: "prod", name: "system.site" }))
      .rejects.toBeInstanceOf(SecurityError);
    expect(callServerTool).not.toHaveBeenCalled();
  });

  it("config_list forwards an optional prefix", async () => {
    callServerTool.mockResolvedValue({});
    await handlers.drupal_config_list({ site: "dev", prefix: "system." });
    expect(callServerTool).toHaveBeenCalledWith(SITES.dev, "configList", { prefix: "system." });
  });

  it("config_set on the Developer tier reaches the server tool", async () => {
    callServerTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    await handlers.drupal_config_set({ site: "dev", name: "system.site", value: { name: "X" } });
    // The public `value` map is forwarded to the server tool under the `data` key.
    expect(callServerTool).toHaveBeenCalledWith(SITES.dev, "configSet", { name: "system.site", data: { name: "X" } });
  });

  it("surfaces a tool the source does not advertise as an error, not an empty result", async () => {
    callServerTool.mockRejectedValue(new Error("Server tool \"mcp_sentinel_config_get\" is not advertised by the source"));
    await expect(handlers.drupal_config_get({ site: "dev", name: "system.site" })).rejects.toThrow(/not advertised by the source/);
  });

  it("config_set is denied on the Content tier (configWrite=false)", async () => {
    await expect(handlers.drupal_config_set({ site: "prod", name: "system.site", value: {} }))
      .rejects.toBeInstanceOf(SecurityError);
    expect(callServerTool).not.toHaveBeenCalled();
  });
});

describe("drupal_config_set on core.extension (#349)", () => {
  const set = (site, name, value) => handlers.drupal_config_set({ site, name, value });
  const withSecurity = async (site, extra, fn) => {
    const previous = SITES[site].security;
    SITES[site].security = { ...previous, ...extra };
    try { await fn(); } finally { SITES[site].security = previous; }
  };
  /** A governed config read result, in the shape the source's config tool returns. */
  const current = (modules) => ({
    content: [{ type: "text", text: JSON.stringify({ name: "core.extension", data: { module: modules, theme: { claro: 0 }, profile: "standard" } }) }],
  });

  it("refuses the write on every preset that can reach the tool, before any server call", async () => {
    for (const site of ["dev", "admin"]) {
      await expect(set(site, "core.extension", { module: { node: 0 } })).rejects.toBeInstanceOf(SecurityError);
      await expect(set(site, "core.extension", { theme: { claro: 0 } })).rejects.toThrow(/core\.extension/);
    }
    expect(callServerTool).not.toHaveBeenCalled();
    expect(callBoundModuleTool).not.toHaveBeenCalled();
  });

  it("names the dedicated module tools and the opt-in key in the refusal", async () => {
    await expect(set("dev", "core.extension", { module: {} })).rejects.toThrow(/drupal_drush_module_enable/);
    await expect(set("dev", "core.extension", { module: {} })).rejects.toThrow(/drupal_drush_module_disable/);
    await expect(set("dev", "core.extension", { module: {} })).rejects.toThrow(/security\.allowCoreExtensionChange/);
  });

  it("refuses a name that differs only by surrounding space or case, which the source would trim", async () => {
    for (const name of [" core.extension", "core.extension\n", "Core.Extension", "\tCORE.EXTENSION "]) {
      await expect(set("dev", name, { module: {} })).rejects.toBeInstanceOf(SecurityError);
    }
    expect(callServerTool).not.toHaveBeenCalled();
  });

  it("refuses on the binding path too", async () => {
    SITES.dev.serverTools.bindings = { configSet: "approved_write", configGet: "approved_read" };
    try {
      await expect(set("dev", "core.extension", { module: {} })).rejects.toBeInstanceOf(SecurityError);
      expect(callBoundModuleTool).not.toHaveBeenCalled();
    } finally {
      delete SITES.dev.serverTools.bindings;
    }
  });

  it("still writes other config objects, including names that only start with core.extension", async () => {
    callServerTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    await set("dev", "system.site", { name: "X" });
    await set("dev", "core.extension_notes.settings", { a: 1 });
    await set("dev", "core.entity_view_display.node.page.default", { status: true });
    expect(callServerTool).toHaveBeenCalledTimes(3);
    expect(callServerTool.mock.calls.every(([, binding]) => binding === "configSet")).toBe(true);
  });

  it("keeps the earlier gates first: read-only and config-write refusals are unchanged", async () => {
    await expect(set("prod", "core.extension", { module: {} })).rejects.toThrow(/Config writes are disabled|scope/i);
  });

  it("blocks the write when the opt-in value is malformed, even a truthy one", async () => {
    for (const bad of ["true", 1, "yes", [], {}]) {
      await withSecurity("dev", { allowCoreExtensionChange: bad }, async () => {
        await expect(set("dev", "core.extension", { theme: { claro: 0 } })).rejects.toThrow(/allowCoreExtensionChange must be true or false/);
      });
    }
    expect(callServerTool).not.toHaveBeenCalled();
  });

  it("with the opt-in, writes a value that does not touch the module list", async () => {
    await withSecurity("dev", { allowCoreExtensionChange: true }, async () => {
      callServerTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      await set("dev", "core.extension", { theme: { claro: 0, olivero: 0 } });
      expect(callServerTool).toHaveBeenCalledTimes(1);
      expect(callServerTool).toHaveBeenCalledWith(SITES.dev, "configSet", { name: "core.extension", data: { theme: { claro: 0, olivero: 0 } } });
    });
  });

  it("with the opt-in, reads the current list and refuses a module map that drops a protected module", async () => {
    await withSecurity("dev", { allowCoreExtensionChange: true }, async () => {
      callServerTool.mockResolvedValueOnce(current({ node: 0, mcp_sentinel: 0, audit_chain: 0, devel: 0 }));
      await expect(set("dev", "core.extension", { module: { node: 0, audit_chain: 0 } }))
        .rejects.toThrow(/would remove protected module.*mcp_sentinel/);
      expect(callServerTool).toHaveBeenCalledTimes(1);
      expect(callServerTool).toHaveBeenCalledWith(SITES.dev, "configGet", { name: "core.extension" });
    });
  });

  it("with the opt-in, writes a module map that keeps every installed protected module", async () => {
    await withSecurity("dev", { allowCoreExtensionChange: true }, async () => {
      callServerTool
        .mockResolvedValueOnce(current({ node: 0, mcp_sentinel: 0, devel: 0 }))
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
      // devel is dropped; encrypt is protected but not installed, so its absence removes nothing.
      await set("dev", "core.extension", { module: { node: 0, mcp_sentinel: 0 } });
      expect(callServerTool).toHaveBeenCalledTimes(2);
      expect(callServerTool.mock.calls[1]).toEqual([SITES.dev, "configSet", { name: "core.extension", data: { module: { node: 0, mcp_sentinel: 0 } } }]);
    });
  });

  it("with the opt-in, reads structuredContent as well as text content", async () => {
    await withSecurity("dev", { allowCoreExtensionChange: true }, async () => {
      callServerTool.mockResolvedValueOnce({ structuredContent: { module: { node: 0, key: 0 } } });
      await expect(set("dev", "core.extension", { module: { node: 0 } })).rejects.toThrow(/would remove protected module.*key/);
    });
  });

  it("with the opt-in, the operator's per-module opt-out is honoured", async () => {
    await withSecurity("dev", { allowCoreExtensionChange: true, allowProtectedModuleUninstall: ["tool"] }, async () => {
      callServerTool
        .mockResolvedValueOnce(current({ node: 0, tool: 0 }))
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });
      await set("dev", "core.extension", { module: { node: 0 } });
      expect(callServerTool).toHaveBeenCalledTimes(2);
    });
  });

  it("with the opt-in, fails closed when the current list cannot be read or understood", async () => {
    await withSecurity("dev", { allowCoreExtensionChange: true }, async () => {
      callServerTool.mockRejectedValueOnce(new Error("Server-tool reported an error: denied"));
      await expect(set("dev", "core.extension", { module: { node: 0 } })).rejects.toThrow(/could not be read/);

      for (const unreadable of [null, { content: [{ type: "text", text: "not json" }] }, { structuredContent: { module: ["node"] } }, { structuredContent: {} }]) {
        callServerTool.mockReset();
        callServerTool.mockResolvedValueOnce(unreadable);
        await expect(set("dev", "core.extension", { module: { node: 0 } })).rejects.toBeInstanceOf(SecurityError);
        expect(callServerTool).toHaveBeenCalledTimes(1);
      }
    });
  });

  it("with the opt-in, fails closed when config reads are disabled for the site", async () => {
    await withSecurity("dev", { allowCoreExtensionChange: true, allowConfigRead: false }, async () => {
      await expect(set("dev", "core.extension", { module: { node: 0 } })).rejects.toBeInstanceOf(SecurityError);
      expect(callServerTool).not.toHaveBeenCalled();
    });
  });

  it("with the opt-in, refuses a module list that is not a map, and a dotted key on a protected module", async () => {
    await withSecurity("dev", { allowCoreExtensionChange: true }, async () => {
      for (const bad of [null, [], "node", 0]) {
        await expect(set("dev", "core.extension", { module: bad })).rejects.toThrow(/must be a map/);
      }
      await expect(set("dev", "core.extension", { "module.mcp_sentinel": null })).rejects.toThrow(/protected module.*mcp_sentinel/);
      await expect(set("dev", "core.extension", { "module.key.weight": 5 })).rejects.toThrow(/protected module.*key/);
      expect(callServerTool).not.toHaveBeenCalled();

      callServerTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      await set("dev", "core.extension", { "module.devel": 0 });
      expect(callServerTool).toHaveBeenCalledTimes(1);
    });
  });

  it("with the opt-in, a malformed protected-module list blocks the write", async () => {
    await withSecurity("dev", { allowCoreExtensionChange: true, protectedModules: "jsonapi" }, async () => {
      await expect(set("dev", "core.extension", { theme: {} })).rejects.toThrow(/security\.protectedModules/);
      expect(callServerTool).not.toHaveBeenCalled();
    });
  });
});

describe("drupal_mcp_whoami", () => {
  it("reports the content tier with config read+write false (no mcp_config) and publish=false", async () => {
    const out = await handlers.drupal_mcp_whoami({ site: "prod" });
    expect(out.tier).toBe("content");
    expect(out.scopes).toEqual(["mcp_read", "mcp_write"]);
    // The content-editor preset allows config reads locally, but without the
    // mcp_config scope the server denies every config_* tool — so the effective
    // capability is false. This is the over-reporting the fix closes.
    expect(out.capabilities.configRead).toBe(false);
    expect(out.capabilities.configWrite).toBe(false);
    expect(out.capabilities.write).toBe(true);
    expect(out.capabilities.publish).toBe(false);
  });

  it("reports the developer tier with config read+write true (holds mcp_config)", async () => {
    const out = await handlers.drupal_mcp_whoami({ site: "dev" });
    expect(out.tier).toBe("developer");
    expect(out.capabilities.configRead).toBe(true);
    expect(out.capabilities.configWrite).toBe(true);
  });

  it("reports the admin tier from the mcp_admin scope", async () => {
    const out = await handlers.drupal_mcp_whoami({ site: "admin" });
    expect(out.tier).toBe("admin");
    expect(out.capabilities.delete).toBe(true);
  });
});
