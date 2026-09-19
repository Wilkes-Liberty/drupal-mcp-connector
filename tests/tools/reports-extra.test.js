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

import { resolveSecurityConfig } from "../../src/lib/security.js";
import { handlers, definitions } from "../../src/tools/reports-extra.js";

const OPEN_SECURITY = {
  globalRedactedFields: [], entityRules: {},
  allowedEntityTypes: null, deniedEntityTypes: [],
};

function canonicalNode(over = {}) {
  return {
    id: "n1", entityType: "node", bundle: "article", title: "T", status: true,
    langcode: "en", created: null, changed: null, url: "/t",
    fields: {}, relationships: {}, _backend: "jsonapi", ...over,
  };
}

beforeEach(() => {
  Object.values(backend).forEach((f) => f.mockReset());
  vi.mocked(resolveSecurityConfig).mockReturnValue(OPEN_SECURITY);
});

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

    // #337: JSON:API omits a field the account may not view. It keeps the key,
    // with a null value, for a field that is merely empty. The two must not be
    // reported the same way.
    it("reports a field absent from every sampled entity as notVisible, not as missing everywhere", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({ id: "a", fields: { body: { value: "x" } } }),
          canonicalNode({ id: "b", fields: { body: null } }),
          canonicalNode({ id: "c", fields: {} }),
        ],
        page: { total: 3, hasNext: false }, approximate: false,
      });
      const out = await handlers.drupal_report_missing_field({ type: "article", field: "field_internal_notes" });
      expect(out.notVisible).toBe(true);
      expect(out.findings).toEqual([]);
      expect(out.totalMissing).toBeNull();
      expect(out.totalAbsent).toBe(3);
      expect(out.scanned).toBe(3);
      expect(out.note).toMatch(/absent from every sampled entity/);
      expect(out.note).toMatch(/denied to this account|not exist on this bundle/);
    });

    it("still counts a field that is present but empty on every entity as missing", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({ id: "a", fields: { field_meta_description: null } }),
          canonicalNode({ id: "b", fields: { field_meta_description: "" } }),
          canonicalNode({ id: "c", fields: { field_meta_description: { value: "" } } }),
        ],
        page: { total: 3, hasNext: false }, approximate: false,
      });
      const out = await handlers.drupal_report_missing_field({ type: "article", field: "field_meta_description" });
      expect(out.notVisible).toBeUndefined();
      expect(out.totalMissing).toBe(3);
      expect(out.totalEmpty).toBe(3);
      expect(out.totalAbsent).toBe(0);
      expect(out.findings.map((f) => f.reason)).toEqual(["empty", "empty", "empty"]);
    });

    it("tells an absent key from an empty value per entity when only some entities omit the field", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({ id: "has", fields: { field_meta_description: { value: "hello" } } }),
          canonicalNode({ id: "empty", fields: { field_meta_description: null } }),
          canonicalNode({ id: "absent", fields: {} }),
        ],
        page: { total: 3, hasNext: false }, approximate: false,
      });
      const out = await handlers.drupal_report_missing_field({ type: "article", field: "field_meta_description" });
      expect(out.notVisible).toBeUndefined();
      expect(Object.fromEntries(out.findings.map((f) => [f.id, f.reason]))).toEqual({ empty: "empty", absent: "absent" });
      expect(out.totalMissing).toBe(2);
      expect(out.totalEmpty).toBe(1);
      expect(out.totalAbsent).toBe(1);
      expect(out.note).toMatch(/1 sampled entit(y|ies) omit/);
    });

    it("applies the same rule to a relationship field", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({ id: "a", relationships: { uid: { id: "u1" } } }),
          canonicalNode({ id: "b", relationships: { uid: { id: "u1" } } }),
        ],
        page: { total: 2, hasNext: false }, approximate: false,
      });
      const hidden = await handlers.drupal_report_missing_field({ type: "article", field: "field_image" });
      expect(hidden.notVisible).toBe(true);
      expect(hidden.findings).toEqual([]);

      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({ id: "a", relationships: { field_image: null } }),
          canonicalNode({ id: "b", relationships: { field_image: [] } }),
        ],
        page: { total: 2, hasNext: false }, approximate: false,
      });
      const empty = await handlers.drupal_report_missing_field({ type: "article", field: "field_image" });
      expect(empty.notVisible).toBeUndefined();
      expect(empty.totalMissing).toBe(2);
      expect(empty.findings.every((f) => f.reason === "empty")).toBe(true);
    });

    it("makes no visibility claim when nothing was sampled", async () => {
      backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0, hasNext: false }, approximate: false });
      const out = await handlers.drupal_report_missing_field({ type: "article", field: "field_x" });
      expect(out.notVisible).toBeUndefined();
      expect(out.totalMissing).toBe(0);
      expect(out.scanned).toBe(0);
    });

    it("never calls a promoted base attribute notVisible: the canonical shape always carries it", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [canonicalNode({ id: "a", title: null, url: null }), canonicalNode({ id: "b", title: "T", url: "/t" })],
        page: { total: 2, hasNext: false }, approximate: false,
      });
      const title = await handlers.drupal_report_missing_field({ type: "article", field: "title" });
      expect(title.notVisible).toBeUndefined();
      expect(title.findings.map((f) => f.id)).toEqual(["a"]);
      // `path` is promoted to `url` and stripped from `fields`.
      const path = await handlers.drupal_report_missing_field({ type: "article", field: "path" });
      expect(path.notVisible).toBeUndefined();
      expect(path.findings.map((f) => f.id)).toEqual(["a"]);
    });

    it("adds no network call per entity", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [canonicalNode({ id: "a" }), canonicalNode({ id: "b" })],
        page: { total: 2, hasNext: false }, approximate: false,
      });
      await handlers.drupal_report_missing_field({ type: "article", field: "field_x" });
      expect(backend.listEntities).toHaveBeenCalledTimes(1);
      expect(backend.getEntity).not.toHaveBeenCalled();
      expect(backend.getEntitySchema).not.toHaveBeenCalled();
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

    it("treats a getEntity 404 as an unresolved (orphaned) reference", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({
            id: "n2", relationships: { field_ref: { id: "boom", entityType: "node", bundle: "page" } },
          }),
        ],
        page: { total: 1, hasNext: false }, approximate: false,
      });
      backend.getEntity.mockRejectedValue(new Error("Drupal 404 on GET /jsonapi/node/page/boom: Not Found"));
      const out = await handlers.drupal_report_orphaned_references({ type: "article" });
      expect(out.totalOrphaned).toBe(1);
      expect(out.orphaned).toBe(1);
      expect(out.unverifiable).toBe(0);
      expect(out.findings[0]).toMatchObject({ id: "n2", field: "field_ref", targetId: "boom" });
    });

    it("does not count a 403 as an orphan (#205)", async () => {
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({
            id: "n2",
            relationships: {
              field_ref: { id: "secret", entityType: "node", bundle: "page" },
            },
          }),
        ],
        page: { total: 1, hasNext: false }, approximate: false,
      });
      backend.getEntity.mockRejectedValue(new Error("Drupal 403 on GET /jsonapi/node/page/secret: Access denied"));
      const out = await handlers.drupal_report_orphaned_references({ type: "article" });
      expect(out.totalOrphaned).toBe(0);
      expect(out.orphaned).toBe(0);
      expect(out.unverifiable).toBe(1);
      expect(out.reason).toBe("target access denied");
      expect(out.reason).not.toBe("target entity type denied by policy");
      expect(out.findings).toEqual([]);
    });

    it("does not report policy-denied user base fields as orphans (#205)", async () => {
      vi.mocked(resolveSecurityConfig).mockReturnValue({
        ...OPEN_SECURITY,
        deniedEntityTypes: ["user"],
      });
      backend.listEntities.mockResolvedValue({
        entities: [
          canonicalNode({
            id: "n1", title: "Keystone",
            relationships: {
              uid: { id: "author-1", entityType: "user", bundle: "user" },
              revision_uid: { id: "editor-1", entityType: "user", bundle: "user" },
              field_topic: { id: "live-term", entityType: "taxonomy_term", bundle: "tags" },
            },
          }),
        ],
        page: { total: 1, hasNext: false }, approximate: false,
      });
      backend.getEntity.mockImplementation(async ({ entityType, id }) => {
        if (entityType === "user") {
          throw new Error(`Drupal 403 on GET /jsonapi/user/user/${id}: Access denied`);
        }
        return canonicalNode({ id });
      });

      const out = await handlers.drupal_report_orphaned_references({ type: "article" });
      expect(out.totalOrphaned).toBe(0);
      expect(out.orphaned).toBe(0);
      expect(out.unverifiable).toBe(2);
      expect(out.reason).toBe("target entity type denied by policy");
      expect(out.findings).toEqual([]);
      const probedTypes = backend.getEntity.mock.calls.map((c) => c[0].entityType);
      expect(probedTypes).not.toContain("user");
      expect(probedTypes).toEqual(["taxonomy_term"]);
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
