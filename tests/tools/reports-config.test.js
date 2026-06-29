import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  site: null,
  sec: null,
  callServerTool: vi.fn(),
  sshDrush: vi.fn(),
}));

vi.mock("../../src/lib/config.js", () => ({ getSiteConfig: vi.fn(() => h.site) }));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return { ...actual, resolveSecurityConfig: vi.fn(() => h.sec) };
});
vi.mock("../../src/lib/server-tools.js", async (orig) => {
  const actual = await orig();
  return { ...actual, callServerTool: h.callServerTool };
});
vi.mock("../../src/tools/drush.js", () => ({
  sshDrush: h.sshDrush,
  // Mirror the real parseDrush: parse JSON, fall back to the raw string.
  parseDrush: (raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  },
}));

import { handlers, definitions } from "../../src/tools/reports-config.js";

/** Wrap a value as an MCP tool result so toolResultData unwraps it. */
const wrap = (data) => ({ structuredContent: data });

beforeEach(() => {
  h.site = { _name: "d", baseUrl: "https://example.com" };
  h.sec = { allowConfigRead: true };
  h.callServerTool.mockReset();
  h.sshDrush.mockReset();
});

describe("reports-config", () => {
  it("definition names match handler keys", () => {
    expect(definitions.map((d) => d.name).sort()).toEqual(Object.keys(handlers).sort());
  });

  describe("drupal_report_config_drift", () => {
    it("gates when drush is not configured", async () => {
      const res = await handlers.drupal_report_config_drift({});
      expect(res.unavailable).toBe(true);
    });
    it("summarizes added/changed/removed via the drush bridge", async () => {
      h.site.drushSsh = { host: "h" };
      h.sshDrush.mockResolvedValue(JSON.stringify([
        { name: "a", state: "create" },
        { name: "b", state: "update" },
        { name: "c", state: "delete" },
      ]));
      const res = await handlers.drupal_report_config_drift({});
      expect(res.inSync).toBe(false);
      expect(res.summary).toEqual({ added: 1, changed: 1, removed: 1 });
    });
  });

  describe("drupal_audit_config_best_practices", () => {
    it("gates without the server-tool bridge but with config read", async () => {
      const res = await handlers.drupal_audit_config_best_practices({});
      expect(res.unavailable).toBe(true);
    });
    it("throws when config reads are disabled", async () => {
      h.sec = { allowConfigRead: false };
      await expect(handlers.drupal_audit_config_best_practices({})).rejects.toThrow(/Config reads/);
    });
    it("flags risky config settings, severity-ranked (server-tool path)", async () => {
      h.site.serverTools = { url: "/mcp" };
      const CONFIGS = {
        "system.logging": { error_level: "all" },
        "system.performance": { css: { preprocess: false }, js: { preprocess: true }, cache: { page: { max_age: 0 } } },
        "user.settings": { register: "visitors" },
        "system.site": { page: { 404: "/404", 403: "" } },
        "system.file": { allow_insecure_uploads: true },
      };
      h.callServerTool.mockImplementation((_site, _tool, args) => Promise.resolve(wrap(CONFIGS[args.name] ?? {})));
      const res = await handlers.drupal_audit_config_best_practices({});
      const ids = res.findings.map((f) => f.id);
      expect(ids).toContain("error_display");
      expect(ids).toContain("open_registration");
      expect(ids).toContain("insecure_uploads");
      expect(ids).toContain("css_aggregation");
      expect(ids).toContain("page_cache");
      expect(ids).toContain("missing_403_page");
      // High-severity findings sort first.
      expect(res.findings[0].severity).toBe("high");
      expect(res.counts.high).toBeGreaterThanOrEqual(3);
    });

    it("is self-sufficient via drush config:get (no server-tool)", async () => {
      h.site.drushSsh = { host: "h" };
      const CONFIGS = {
        "system.logging": { error_level: "all" },
        "user.settings": { register: "visitors" },
      };
      h.sshDrush.mockImplementation((_s, args) => Promise.resolve(JSON.stringify(CONFIGS[args[1]] ?? {})));
      const res = await handlers.drupal_audit_config_best_practices({});
      const ids = res.findings.map((f) => f.id);
      expect(ids).toContain("error_display");
      expect(ids).toContain("open_registration");
    });
  });

  describe("drupal_report_module_audit", () => {
    it("flags dev modules and security advisories via drush", async () => {
      h.site.drushSsh = { host: "h" };
      h.sshDrush
        .mockResolvedValueOnce(JSON.stringify({
          devel: { status: "enabled", version: "5.0" },
          views: { status: "enabled", version: "1.0" },
        }))
        .mockResolvedValueOnce(JSON.stringify({ ctools: { name: "ctools" } }));
      const res = await handlers.drupal_report_module_audit({});
      expect(res.summary.devModulesEnabled).toBe(1);
      expect(res.findings.enabledDevModules[0].name).toBe("devel");
      expect(res.summary.securityAdvisories).toBe(1);
    });
  });

  describe("drupal_report_permission_audit", () => {
    it("flags dangerous anonymous perms and non-admin admin perms", async () => {
      h.site.drushSsh = { host: "h" };
      h.sshDrush.mockResolvedValue(JSON.stringify({
        anonymous: { permissions: ["access content", "administer users"] },
        editor: { permissions: ["administer nodes"] },
        administrator: { permissions: ["administer site configuration"] },
      }));
      const res = await handlers.drupal_report_permission_audit({});
      const ids = res.findings.map((f) => f.id);
      expect(ids).toContain("dangerous_perm_anonymous");
      expect(ids).toContain("admin_perm_editor");
      // administrator's elevated perms are expected, not flagged.
      expect(ids.some((i) => i.includes("administrator"))).toBe(false);
    });
  });

  describe("drupal_report_status_report", () => {
    it("filters requirement rows by severity via drush", async () => {
      h.site.drushSsh = { host: "h" };
      h.sshDrush.mockResolvedValue(JSON.stringify([
        { title: "Cron", severity: "warning", value: "overdue" },
        { title: "Updates", severity: "error", value: "pending" },
        { title: "PHP", severity: "ok", value: "8.3" },
      ]));
      const res = await handlers.drupal_report_status_report({});
      expect(res.counts).toEqual({ error: 1, warning: 1 });
      expect(res.findings).toHaveLength(2);
      const errOnly = await handlers.drupal_report_status_report({ minSeverity: "error" });
      expect(errOnly.findings).toHaveLength(1);
    });
  });

  describe("drupal_report_text_format_audit", () => {
    it("flags formats that allow unfiltered HTML (server-tool path)", async () => {
      h.site.serverTools = { url: "/mcp" };
      h.callServerTool.mockImplementation((_s, _tool, args) => {
        if (args.prefix) return Promise.resolve(wrap(["filter.format.full_html", "filter.format.basic_html"]));
        const map = {
          "filter.format.full_html": { format: "full_html", name: "Full HTML", status: true, filters: {} },
          "filter.format.basic_html": { format: "basic_html", name: "Basic HTML", status: true, filters: { filter_html: { status: true } } },
        };
        return Promise.resolve(wrap(map[args.name]));
      });
      const res = await handlers.drupal_report_text_format_audit({});
      expect(res.formatsAudited).toBe(2);
      expect(res.findings).toHaveLength(1);
      expect(res.findings[0].format).toBe("full_html");
    });

    it("is self-sufficient via drush (sql:query list + config:get)", async () => {
      h.site.drushSsh = { host: "h" };
      h.sshDrush.mockImplementation((_s, args) => {
        if (args[0] === "sql:query") return Promise.resolve("filter.format.full_html\nfilter.format.basic_html\n");
        const map = {
          "filter.format.full_html": { format: "full_html", name: "Full HTML", status: true, filters: {} },
          "filter.format.basic_html": { format: "basic_html", name: "Basic HTML", status: true, filters: { filter_html: { status: true } } },
        };
        return Promise.resolve(JSON.stringify(map[args[1]]));
      });
      const res = await handlers.drupal_report_text_format_audit({});
      expect(res.formatsAudited).toBe(2);
      expect(res.findings.map((f) => f.format)).toEqual(["full_html"]);
    });
  });

  describe("drupal_report_cache_config", () => {
    it("reports posture and recommendations", async () => {
      h.site.serverTools = { url: "/mcp" };
      h.callServerTool.mockResolvedValue(wrap({ css: { preprocess: false }, js: { preprocess: true }, cache: { page: { max_age: 0 } } }));
      const res = await handlers.drupal_report_cache_config({});
      expect(res.posture).toEqual({ cssAggregation: false, jsAggregation: true, pageCacheMaxAge: 0 });
      expect(res.recommendations).toHaveLength(2);
    });
  });
});
