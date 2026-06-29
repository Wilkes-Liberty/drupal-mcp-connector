import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  backend: {
    listEntities: vi.fn(),
    getEntity: vi.fn(),
    countEntities: vi.fn(),
    capabilities: vi.fn(() => ({ name: "jsonapi" })),
  },
  site: null,
  callServerTool: vi.fn(),
  sshDrush: vi.fn(),
  checkLinks: vi.fn(),
}));
const { backend, callServerTool, sshDrush, checkLinks } = h;

vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => h.backend) }));
vi.mock("../../src/lib/config.js", () => ({ getSiteConfig: vi.fn(() => h.site) }));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return { ...actual, resolveSecurityConfig: vi.fn(() => ({ allowedEntityTypes: null, deniedEntityTypes: [], entityRules: {} })) };
});
vi.mock("../../src/lib/server-tools.js", async (orig) => {
  const actual = await orig();
  return { ...actual, callServerTool: h.callServerTool };
});
vi.mock("../../src/tools/drush.js", () => ({
  sshDrush: h.sshDrush,
  parseDrush: (raw) => (typeof raw === "string" ? JSON.parse(raw) : raw),
}));
vi.mock("../../src/lib/link-checker.js", () => ({ checkLinks: h.checkLinks }));

import { handlers, definitions } from "../../src/tools/reports-links.js";

/** Build a canonical node with body HTML. */
function node(over = {}) {
  return { id: "n1", title: "T", status: true, url: "/t", fields: {}, relationships: {}, ...over };
}
/** Build a canonical entity whose fields carry the given map. */
function ent(id, fields) {
  return { id, title: id, fields, relationships: {} };
}
/** Make listEntities resolve a single, terminal page. */
function page(entities) {
  return { entities, page: { hasNext: false }, approximate: false };
}

beforeEach(() => {
  h.site = { _name: "d", baseUrl: "https://example.com" };
  backend.listEntities.mockReset();
  backend.getEntity.mockReset();
  callServerTool.mockReset();
  sshDrush.mockReset();
  checkLinks.mockReset();
});

describe("reports-links", () => {
  it("definition names match handler keys", () => {
    expect(definitions.map((d) => d.name).sort()).toEqual(Object.keys(handlers).sort());
    for (const d of definitions) expect(d.inputSchema.type).toBe("object");
  });

  describe("drupal_report_404_log", () => {
    it("gates when neither server-tool nor drush is configured", async () => {
      const res = await handlers.drupal_report_404_log({});
      expect(res.unavailable).toBe(true);
      expect(res.report).toBe("report_404_log");
    });

    it("aggregates and ranks via the drush watchdog bridge", async () => {
      h.site.drushSsh = { host: "h" };
      sshDrush.mockResolvedValue(JSON.stringify([{ path: "/a" }, { path: "/a" }, { location: "/b" }]));
      const res = await handlers.drupal_report_404_log({ limit: 10 });
      expect(res.source).toBe("drush");
      expect(res.findings[0]).toEqual({ path: "/a", hits: 2 });
      expect(res.distinctPaths).toBe(2);
    });

    it("normalizes bare message paths into leading-slash paths", async () => {
      h.site.drushSsh = { host: "h" };
      sshDrush.mockResolvedValue(JSON.stringify([{ message: "missing/x" }, { message: "missing/x" }]));
      const res = await handlers.drupal_report_404_log({});
      expect(res.source).toBe("drush");
      expect(res.findings[0]).toEqual({ path: "/missing/x", hits: 2 });
    });
  });

  describe("drupal_report_redirect_health", () => {
    it("detects duplicate sources, self-redirects, and chains", async () => {
      backend.listEntities.mockResolvedValue(page([
        ent("r1", { redirect_source: { path: "/old" }, redirect_redirect: "internal:/mid", status_code: 301 }),
        ent("r2", { redirect_source: { path: "/mid" }, redirect_redirect: "internal:/new", status_code: 301 }),
        ent("r3", { redirect_source: { path: "/old" }, redirect_redirect: "internal:/other", status_code: 301 }),
        ent("r4", { redirect_source: { path: "/self" }, redirect_redirect: "internal:/self", status_code: 301 }),
      ]));
      const res = await handlers.drupal_report_redirect_health({});
      expect(res.totalRedirects).toBe(4);
      expect(res.summary.duplicateSources).toBe(1);
      expect(res.summary.selfRedirects).toBe(1);
      expect(res.summary.chains).toBeGreaterThanOrEqual(1);
    });

    it("gates when the redirect entity is not listable", async () => {
      backend.listEntities.mockRejectedValue(new Error("404 resource"));
      const res = await handlers.drupal_report_redirect_health({});
      expect(res.unavailable).toBe(true);
    });
  });

  describe("drupal_report_broken_links", () => {
    it("inventories links without network egress by default", async () => {
      backend.listEntities.mockResolvedValue(page([
        node({ fields: { body: { value: '<a href="/in">i</a><a href="https://ext.com/x">e</a><a href="#f">f</a>' } } }),
      ]));
      const res = await handlers.drupal_report_broken_links({ type: "page" });
      expect(checkLinks).not.toHaveBeenCalled();
      expect(res.summary).toMatchObject({ internal: 1, external: 1, fragments: 1 });
      expect(res.externalHosts[0]).toEqual({ host: "ext.com", count: 1 });
      expect(res.liveChecked).toBe(false);
    });

    it("runs the guarded live checker when checkLive is set", async () => {
      backend.listEntities.mockResolvedValue(page([
        node({ fields: { body: { value: '<a href="/in">i</a>' } } }),
      ]));
      checkLinks.mockResolvedValue({ checked: 1, truncated: false, results: [{ url: "https://example.com/in", ok: false, skipped: false, status: 404 }] });
      const res = await handlers.drupal_report_broken_links({ checkLive: true });
      expect(checkLinks).toHaveBeenCalledOnce();
      expect(res.liveChecked).toBe(true);
      expect(res.live.broken).toHaveLength(1);
    });
  });

  describe("drupal_report_alias_coverage", () => {
    it("flags nodes whose URL is still /node/N and finds conflicting aliases", async () => {
      // First call: nodes. Second call: path_alias.
      backend.listEntities
        .mockResolvedValueOnce(page([node({ id: "n1", url: "/node/5" }), node({ id: "n2", url: "/about" })]))
        .mockResolvedValueOnce(page([
          ent("a1", { alias: "/dup", path: "/node/1" }),
          ent("a2", { alias: "/dup", path: "/node/2" }),
        ]));
      const res = await handlers.drupal_report_alias_coverage({ type: "page" });
      expect(res.totalMissingAlias).toBe(1);
      expect(res.missingAlias[0].id).toBe("n1");
      expect(res.aliasConflicts.available).toBe(true);
      expect(res.aliasConflicts.conflicting[0]).toMatchObject({ alias: "/dup" });
    });
  });

  describe("drupal_report_menu_integrity", () => {
    it("classifies disabled, placeholder, and external menu links", async () => {
      backend.listEntities.mockResolvedValue(page([
        { id: "m1", title: "Home", fields: { enabled: true, link: "internal:/", menu_name: "main" } },
        { id: "m2", title: "Off", fields: { enabled: false, link: "internal:/x", menu_name: "main" } },
        { id: "m3", title: "Placeholder", fields: { enabled: true, link: "route:<nojs>", menu_name: "main" } },
        { id: "m4", title: "Ext", fields: { enabled: true, link: "https://other.org", menu_name: "main" } },
      ]));
      const res = await handlers.drupal_report_menu_integrity({});
      expect(res.summary).toMatchObject({ disabled: 1, placeholderTargets: 1, externalLinks: 1 });
    });
  });

  describe("drupal_report_broken_embeds", () => {
    it("counts embeds by type and flags malformed UUIDs", async () => {
      backend.listEntities.mockResolvedValue(page([
        node({ fields: { body: { value:
          '<drupal-media data-entity-type="media" data-entity-uuid="11111111-1111-1111-1111-111111111111"></drupal-media>' +
          '<drupal-media data-entity-type="media" data-entity-uuid="bad"></drupal-media>' } } }),
      ]));
      const res = await handlers.drupal_report_broken_embeds({ type: "page" });
      expect(res.totalEmbeds).toBe(2);
      expect(res.byType).toEqual([{ entityType: "media", count: 2 }]);
      expect(res.malformed).toHaveLength(1);
    });
  });
});
