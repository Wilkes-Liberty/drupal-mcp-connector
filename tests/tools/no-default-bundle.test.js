/**
 * A site without an `article` bundle (#403).
 *
 * Node tools used to default `type` to "article". On a site without that
 * bundle, JSON:API returns 404 (or the scan reads nothing). Bundle-scoped
 * audits now require `type`; list-style tools scan every node bundle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  backend: {
    listEntities: vi.fn(),
    countEntities: vi.fn(),
    listContentTypes: vi.fn(),
    getEntity: vi.fn(),
    getEntitySchema: vi.fn(),
    rawQuery: vi.fn(),
    resourcePath: vi.fn((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`),
    capabilities: vi.fn(() => ({ revisions: true, fieldAvailability: () => [] })),
  },
}));
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => h.backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveSecurityConfig: vi.fn(() => ({
      readOnly: false, allowDestructive: false, allowedEntityTypes: null, deniedEntityTypes: [],
      globalRedactedFields: [], entityRules: {},
    })),
  };
});

import * as reports from "../../src/tools/reports.js";
import * as reportsLinks from "../../src/tools/reports-links.js";
import * as reportsExtra from "../../src/tools/reports-extra.js";
import * as nodes from "../../src/tools/nodes.js";
import * as search from "../../src/tools/search.js";
import * as composite from "../../src/tools/audit-composite.js";

const { backend } = h;
const all = {
  ...reports.handlers, ...reportsLinks.handlers, ...reportsExtra.handlers, ...nodes.handlers,
  ...search.handlers, ...composite.handlers,
};
const definitions = [
  ...reports.definitions, ...reportsLinks.definitions, ...reportsExtra.definitions, ...nodes.definitions,
  ...search.definitions, ...composite.definitions,
];

function node(id, over = {}) {
  return { id, entityType: "node", title: `T ${id}`, status: true, langcode: "en",
    created: "2026-09-01T00:00:00Z", changed: "2026-09-01T00:00:00Z", url: `/${id}`,
    fields: {}, relationships: {}, ...over };
}

beforeEach(() => {
  Object.values(backend).forEach((f) => f.mockReset?.());
  backend.resourcePath.mockImplementation((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`);
  backend.listContentTypes.mockResolvedValue([{ id: "page" }, { id: "resource" }]);
  backend.listEntities.mockImplementation(async ({ bundle }) => {
    if (bundle === "page") {
      return { entities: [node("p1", { changed: "2026-09-03T00:00:00Z", created: "2026-09-03T00:00:00Z" })], page: { hasNext: false } };
    }
    if (bundle === "resource") {
      return { entities: [node("r1", { changed: "2026-09-02T00:00:00Z", created: "2026-09-02T00:00:00Z" })], page: { hasNext: false } };
    }
    throw Object.assign(new Error(`Drupal 404 on GET /jsonapi/node/${bundle}: Page not found`), { status: 404 });
  });
});

function bundlesRead() {
  return backend.listEntities.mock.calls.map(([d]) => d.bundle);
}

describe("node tools on a site without an article bundle (#403)", () => {
  const requireType = [
    ["drupal_report_stale_content", {}],
    ["drupal_report_content_by_author", {}],
    ["drupal_report_taxonomy_usage", { vocabulary: "tags" }],
    ["drupal_report_revision_hotspots", {}],
    ["drupal_report_seo_audit", {}],
    ["drupal_report_accessibility_audit", {}],
    ["drupal_report_broken_links", {}],
    ["drupal_report_alias_coverage", {}],
    ["drupal_report_broken_embeds", {}],
    ["drupal_report_missing_field", { field: "body" }],
    ["drupal_report_orphaned_references", {}],
  ];

  it.each(requireType)("%s fails clearly without a content type", async (name, args) => {
    await expect(all[name](args)).rejects.toThrow(/drupal_list_content_types/);
    expect(backend.listEntities).not.toHaveBeenCalled();
    expect(backend.rawQuery).not.toHaveBeenCalled();
  });

  it("drupal_report_recently_published scans every bundle, newest first", async () => {
    const res = await all.drupal_report_recently_published({ limit: 5 });
    expect(bundlesRead()).not.toContain("article");
    expect(res.contentType).toBeNull();
    expect(res.nodes.map((n) => n.id)).toEqual(["p1", "r1"]);
    expect(res.nodes[0].contentType).toBe("page");
  });

  it("drupal_report_unpublished scans every bundle and lists a failing bundle", async () => {
    backend.listContentTypes.mockResolvedValue([{ id: "page" }, { id: "resource" }, { id: "gone" }]);
    const res = await all.drupal_report_unpublished({});
    expect(bundlesRead()).not.toContain("article");
    expect(res.contentType).toBeNull();
    expect(res.findings.map((f) => f.id)).toEqual(["p1", "r1"]);
    expect(res.bundleErrors).toEqual([expect.objectContaining({ contentType: "gone", error: expect.stringMatching(/404/) })]);
  });

  it("drupal_search_content searches every bundle", async () => {
    const res = await all.drupal_search_content({ query: "T" });
    expect(bundlesRead()).not.toContain("article");
    expect(res.map((n) => n.id)).toEqual(["p1", "r1"]);
  });

  it("drupal_search_content fails loudly when a bundle cannot be read, rather than returning partial results", async () => {
    backend.listContentTypes.mockResolvedValue([{ id: "page" }, { id: "gone" }]);
    await expect(all.drupal_search_content({ query: "T" })).rejects.toThrow(/gone.*404|404.*gone/s);
  });

  it("drupal_search searches every bundle", async () => {
    const res = await all.drupal_search({ query: "T" });
    expect(bundlesRead()).not.toContain("article");
    expect(res.type).toBeNull();
    expect(res.results.map((n) => n.id)).toEqual(["p1", "r1"]);
  });

  it("drupal_search fails loudly when a bundle cannot be read", async () => {
    backend.listContentTypes.mockResolvedValue([{ id: "page" }, { id: "gone" }]);
    await expect(all.drupal_search({ query: "T" })).rejects.toThrow(/gone.*404|404.*gone/s);
  });

  it("drupal_audit_site_health without type marks bundle sections unavailable instead of auditing a guessed bundle", async () => {
    const res = await all.drupal_audit_site_health({ sections: ["stale_content", "seo_audit"] });
    expect(bundlesRead()).not.toContain("article");
    expect(res.type).toBeNull();
    for (const section of res.sections) {
      expect(section.status).toBe("unavailable");
      expect(section.reason).toMatch(/type/);
    }
    expect(res.summary.errored).toBe(0);
  });

  it("no definition advertises an article default", () => {
    for (const def of definitions) {
      expect(JSON.stringify(def), def.name).not.toMatch(/default: article|defaults to the article/i);
    }
  });
});
