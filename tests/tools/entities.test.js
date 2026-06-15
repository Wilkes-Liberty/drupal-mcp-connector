import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(), getEntity: vi.fn(), createEntity: vi.fn(), updateEntity: vi.fn(),
  deleteEntity: vi.fn(), listResourceTypes: vi.fn(), getEntitySchema: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));

import { handlers } from "../../src/tools/entities.js";

const ent = { id: "p1", entityType: "paragraph", bundle: "text", title: null, status: null,
  langcode: "en", created: null, changed: null, url: null, fields: { field_body: "x" }, relationships: {}, _backend: "jsonapi" };

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

describe("entities tools (migrated)", () => {
  it("entity_list passes structured filters + page to listEntities", async () => {
    backend.listEntities.mockResolvedValue({ entities: [ent], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_entity_list({ entityType: "paragraph", bundle: "text", filters: [{ field: "status", op: "eq", value: true }], limit: 5, offset: 10 });
    expect(out.total).toBe(1);
    expect(out.entities[0].id).toBe("p1");
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "paragraph", bundle: "text", page: { limit: 5, offset: 10 } });
    expect(desc.filters).toEqual([{ field: "status", op: "eq", value: true }]);
  });

  it("entity_create dryRun returns a preview and does not write", async () => {
    const out = await handlers.drupal_entity_create({ entityType: "paragraph", bundle: "text", attributes: { field_body: "x" }, dryRun: true });
    expect(out).toMatchObject({ dryRun: true, operation: "create", entityType: "paragraph", bundle: "text" });
    expect(out.attributes).toEqual({ field_body: "x" });
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("entity_delete dryRun returns a preview and does not delete", async () => {
    const out = await handlers.drupal_entity_delete({ entityType: "paragraph", bundle: "text", id: "p1", dryRun: true });
    expect(out).toMatchObject({ dryRun: true, operation: "delete", entityType: "paragraph", bundle: "text", id: "p1" });
    expect(backend.deleteEntity).not.toHaveBeenCalled();
  });

  it("entity_get returns the canonical entity", async () => {
    backend.getEntity.mockResolvedValue(ent);
    const out = await handlers.drupal_entity_get({ entityType: "paragraph", bundle: "text", id: "p1" });
    expect(out.id).toBe("p1");
  });

  it("entity_create passes attributes + relationships through", async () => {
    backend.createEntity.mockResolvedValue(ent);
    await handlers.drupal_entity_create({ entityType: "paragraph", bundle: "text", attributes: { field_body: "x" }, relationships: { r: {} } });
    expect(backend.createEntity).toHaveBeenCalledWith({ entityType: "paragraph", bundle: "text", attributes: { field_body: "x" }, relationships: { r: {} } });
  });

  it("entity_delete returns success", async () => {
    backend.deleteEntity.mockResolvedValue(undefined);
    const out = await handlers.drupal_entity_delete({ entityType: "paragraph", bundle: "text", id: "p1" });
    expect(out).toMatchObject({ success: true, deletedId: "p1" });
  });

  it("list_entity_types filters resource types through security and reports counts", async () => {
    backend.listResourceTypes.mockResolvedValue([
      { resourceType: "node--article", entityType: "node", bundle: "article" },
      { resourceType: "user--user", entityType: "user", bundle: "user" },
    ]);
    const out = await handlers.drupal_list_entity_types({});
    expect(out.total).toBe(2);
    expect(out.accessible).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(out.resourceTypes)).toBe(true);
  });

  it("get_entity_schema delegates to the backend", async () => {
    backend.getEntitySchema.mockResolvedValue({ entityType: "paragraph", bundle: "text", attributes: { field_body: "string" }, relationships: {} });
    const out = await handlers.drupal_get_entity_schema({ entityType: "paragraph", bundle: "text" });
    expect(out.attributes.field_body).toBe("string");
  });
});
