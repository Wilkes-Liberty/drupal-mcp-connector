import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(), getEntity: vi.fn(), createEntity: vi.fn(),
  updateEntity: vi.fn(), deleteEntity: vi.fn(), listBundles: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return { ...actual, resolveSecurityConfig: vi.fn(() => ({ globalRedactedFields: [], entityRules: {} })) };
});

import { handlers } from "../../src/tools/taxonomy.js";

const term = { id: "t1", entityType: "taxonomy_term", bundle: "tags", title: "Tag", status: true,
  langcode: "en", created: null, changed: null, url: null, fields: { name: "Tag", weight: 0 }, relationships: {}, _backend: "jsonapi" };

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

describe("taxonomy tools (migrated)", () => {
  it("list_vocabularies uses listBundles", async () => {
    backend.listBundles.mockResolvedValue([{ id: "tags", label: "Tags", description: null }]);
    const out = await handlers.drupal_list_vocabularies({});
    expect(out).toEqual([{ id: "tags", label: "Tags", description: null }]);
    expect(backend.listBundles).toHaveBeenCalledWith("taxonomy_term");
  });

  it("get_taxonomy_terms lists terms in the vocabulary bundle", async () => {
    backend.listEntities.mockResolvedValue({ entities: [term], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_get_taxonomy_terms({ vocabulary: "tags", limit: 10 });
    expect(out.total).toBe(1);
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "taxonomy_term", bundle: "tags", page: { limit: 10, offset: 0 } });
  });

  it("create_taxonomy_term builds description wrapper + parent relationship", async () => {
    backend.createEntity.mockResolvedValue(term);
    await handlers.drupal_create_taxonomy_term({ vocabulary: "tags", name: "New", description: "d", weight: 2, parentId: "p1" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "taxonomy_term", bundle: "tags" });
    expect(arg.attributes.name).toBe("New");
    expect(arg.attributes.weight).toBe(2);
    expect(arg.attributes.description).toEqual({ value: "d", format: "plain_text" });
    expect(arg.relationships.parent).toEqual({ data: [{ type: "taxonomy_term--tags", id: "p1" }] });
  });

  it("update_taxonomy_term sets only provided fields and calls updateEntity", async () => {
    backend.updateEntity.mockResolvedValue(term);
    await handlers.drupal_update_taxonomy_term({ vocabulary: "tags", id: "t1", name: "Renamed", description: "d2" });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "taxonomy_term", bundle: "tags", id: "t1" });
    expect(arg.attributes.name).toBe("Renamed");
    expect(arg.attributes.description).toEqual({ value: "d2", format: "plain_text" });
    expect(arg.attributes).not.toHaveProperty("weight");
  });

  it("delete_taxonomy_term calls deleteEntity", async () => {
    backend.deleteEntity.mockResolvedValue(undefined);
    const out = await handlers.drupal_delete_taxonomy_term({ vocabulary: "tags", id: "t1" });
    expect(out).toEqual({ success: true, deletedId: "t1" });
  });
});
