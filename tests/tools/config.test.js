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

const callServerTool = vi.fn();
vi.mock("../../src/lib/server-tools.js", () => ({
  callServerTool: (...args) => callServerTool(...args),
  SERVER_TOOLS: { configGet: "config_get", configList: "config_list", configSet: "config_set" },
}));

import { handlers } from "../../src/tools/config.js";
import { SecurityError } from "../../src/lib/security.js";

beforeEach(() => callServerTool.mockReset());

describe("config tools — governed via server-tool bridge", () => {
  it("config_get on a config tier (mcp_config) calls the server tool", async () => {
    callServerTool.mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    await handlers.drupal_config_get({ site: "dev", name: "system.site" });
    expect(callServerTool).toHaveBeenCalledWith(SITES.dev, "config_get", { name: "system.site" });
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
    expect(callServerTool).toHaveBeenCalledWith(SITES.dev, "config_list", { prefix: "system." });
  });

  it("config_set on the Developer tier reaches the server tool", async () => {
    callServerTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    await handlers.drupal_config_set({ site: "dev", name: "system.site", value: { name: "X" } });
    expect(callServerTool).toHaveBeenCalledWith(SITES.dev, "config_set", { name: "system.site", value: { name: "X" } });
  });

  it("config_set is denied on the Content tier (configWrite=false)", async () => {
    await expect(handlers.drupal_config_set({ site: "prod", name: "system.site", value: {} }))
      .rejects.toBeInstanceOf(SecurityError);
    expect(callServerTool).not.toHaveBeenCalled();
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
