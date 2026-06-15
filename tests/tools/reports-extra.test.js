import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(),
  getEntity: vi.fn(),
  getEntitySchema: vi.fn(),
  countEntities: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveSecurityConfig: vi.fn(() => ({
      globalRedactedFields: [], entityRules: {},
      allowedEntityTypes: null, deniedEntityTypes: [],
    })),
  };
});

import { handlers, definitions } from "../../src/tools/reports-extra.js";

function canonicalNode(over = {}) {
  return {
    id: "n1", entityType: "node", bundle: "article", title: "T", status: true,
    langcode: "en", created: null, changed: null, url: "/t",
    fields: {}, relationships: {}, _backend: "jsonapi", ...over,
  };
}

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

describe("reports-extra tools", () => {
  it("exports three definitions whose names match the handler keys", () => {
    const defNames = definitions.map((d) => d.name).sort();
    expect(defNames).toEqual([
      "drupal_report_missing_field",
      "drupal_report_orphaned_references",
      "drupal_report_unpublished",
    ]);
    for (const d of definitions) {
      expect(handlers[d.name]).toBeTypeOf("function");
      expect(d.inputSchema.type).toBe("object");
    }
  });

  // -------------------------------------------------------------------------
  // drupal_report_unpublished
  // -------------------------------------------------------------------------
  describe("drupal_report_unpublished", () => {
    it("filters by status:false and returns a finding list", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [canonicalNode({ id: "u1", status: false, title: "Draft" })],
        page: { total: 1, hasNext: false }, approximate: false,
      });
      const out = await handlers.drupal_report_unpublished({ type: "article", limit: 10 });
      const desc = backend.listEntities.mock.calls[0][0];
      expect(desc).toMatchObject({ entityType: "node", bundle: "article" });
      expect(desc.filters).toEqual(expect.arrayContaining([{ field: "status", op: "eq", value: false }]));
      expect(out.contentType).toBe("article");
      expect(out.totalUnpublished).toBe(1);
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0]).toMatchObject({ id: "u1", title: "Draft", status: "unpublished" });
    });

    it("defaults the content type to article", async () => {
      backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
      await handlers.drupal_report_unpublished({});
      expect(backend.listEntities.mock.calls[0][0]).toMatchObject({ bundle: "article" });
    });

    it("propagates approximate from the backend", async () => {
      backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: true });
      const out = await handlers.drupal_report_unpublished({ type: "page" });
      expect(out.approximate).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // drupal_report_missing_field
  // -------------------------------------------------------------------------
  describe("drupal_report_missing_field", () => {
    it("requires a field argument", async () => {
      await expect(handlers.drupal_report_missing_field({ type: "article" })).rejects.toThrow(/field/i);
    });

    it("flags entities whose field is empty", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({ id: "a", title: "Has meta", fields: { field_meta_description: { value: "hello" } } }),
          canonicalNode({ id: "b", title: "Empty string", fields: { field_meta_description: { value: "" } } }),
          canonicalNode({ id: "c", title: "Null", fields: { field_meta_description: null } }),
          canonicalNode({ id: "d", title: "Missing key", fields: {} }),
        ],
        page: { total: 4, hasNext: false }, approximate: false,
      });
      const out = await handlers.drupal_report_missing_field({ type: "article", field: "field_meta_description" });
      expect(out.field).toBe("field_meta_description");
      expect(out.scanned).toBe(4);
      const ids = out.findings.map((f) => f.id).sort();
      expect(ids).toEqual(["b", "c", "d"]);
    });

    it("treats an empty relationship as missing", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({ id: "withref", relationships: { field_image: { id: "img1" } } }),
          canonicalNode({ id: "noref", relationships: { field_image: null } }),
          canonicalNode({ id: "emptyarr", relationships: { field_image: [] } }),
        ],
        page: { total: 3, hasNext: false }, approximate: false,
      });
      const out = await handlers.drupal_report_missing_field({ type: "article", field: "field_image" });
      const ids = out.findings.map((f) => f.id).sort();
      expect(ids).toEqual(["emptyarr", "noref"]);
    });

    it("flags approximate when the sample is bounded by the cap", async () => {
      const many = Array.from({ length: 50 }, (_, i) => canonicalNode({ id: `x${i}`, fields: {} }));
      backend.listEntities.mockResolvedValue({
        entities: many, page: { total: 999, hasNext: true }, approximate: false,
      });
      const out = await handlers.drupal_report_missing_field({ type: "article", field: "field_x", sampleSize: 50 });
      expect(out.approximate).toBe(true);
      expect(out.sampled).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // drupal_report_orphaned_references
  // -------------------------------------------------------------------------
  describe("drupal_report_orphaned_references", () => {
    it("reports references whose targets cannot be resolved", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({
            id: "n1", title: "Good + bad refs",
            relationships: {
              field_author: { id: "live", entityType: "user", bundle: "user" },
              field_topic: { id: "dead", entityType: "taxonomy_term", bundle: "tags" },
              uid: { id: "live", entityType: "user", bundle: "user" },
            },
          }),
        ],
        page: { total: 1, hasNext: false }, approximate: false,
      });
      // "live" resolves; "dead" returns null (missing target).
      backend.getEntity.mockImplementation(async ({ id }) => (id === "live" ? canonicalNode({ id }) : null));

      const out = await handlers.drupal_report_orphaned_references({ type: "article", sampleSize: 10 });
      expect(out.scanned).toBe(1);
      expect(out.totalOrphaned).toBe(1);
      expect(out.findings).toHaveLength(1);
      expect(out.findings[0]).toMatchObject({
        id: "n1", field: "field_topic", targetId: "dead", targetEntityType: "taxonomy_term",
      });
      // uid is a base relationship and should be skippable / still resolved fine.
      expect(out.findings.some((f) => f.targetId === "live")).toBe(false);
    });

    it("treats a getEntity error as an unresolved (orphaned) reference", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({
            id: "n2", relationships: { field_ref: { id: "boom", entityType: "node", bundle: "page" } },
          }),
        ],
        page: { total: 1, hasNext: false }, approximate: false,
      });
      backend.getEntity.mockRejectedValue(new Error("404"));
      const out = await handlers.drupal_report_orphaned_references({ type: "article" });
      expect(out.totalOrphaned).toBe(1);
      expect(out.findings[0]).toMatchObject({ id: "n2", field: "field_ref", targetId: "boom" });
    });

    it("handles arrays of references and de-dupes target lookups", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({
            id: "n3",
            relationships: {
              field_tags: [
                { id: "t1", entityType: "taxonomy_term", bundle: "tags" },
                { id: "t1", entityType: "taxonomy_term", bundle: "tags" },
                { id: "t2", entityType: "taxonomy_term", bundle: "tags" },
              ],
            },
          }),
        ],
        page: { total: 1, hasNext: false }, approximate: false,
      });
      backend.getEntity.mockResolvedValue(null); // both missing
      const out = await handlers.drupal_report_orphaned_references({ type: "article" });
      // t1 and t2 both orphaned -> 2 findings, but getEntity called once per unique id.
      const targets = out.findings.map((f) => f.targetId).sort();
      expect(targets).toEqual(["t1", "t2"]);
      const uniqueIdsLookedUp = new Set(backend.getEntity.mock.calls.map((c) => c[0].id));
      expect(uniqueIdsLookedUp).toEqual(new Set(["t1", "t2"]));
    });

    it("flags approximate when the entity sample is bounded", async () => {
      const many = Array.from({ length: 5 }, (_, i) =>
        canonicalNode({ id: `e${i}`, relationships: {} }));
      backend.listEntities.mockResolvedValue({
        entities: many, page: { total: 500, hasNext: true }, approximate: false,
      });
      const out = await handlers.drupal_report_orphaned_references({ type: "article", sampleSize: 5 });
      expect(out.approximate).toBe(true);
    });
  });
});
