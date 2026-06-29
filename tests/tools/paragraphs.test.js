import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(),
  getEntity: vi.fn(),
  createEntity: vi.fn(),
  updateEntity: vi.fn(),
  deleteEntity: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
// Per-test site security can be overridden via setSecurity(); default is permissive ({}).
let siteSecurity = {};
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: siteSecurity })),
}));
// NOTE: security.js is intentionally NOT mocked — these handlers assert in-handler
// (entity-type-aware), so we exercise the real policy engine, mirroring entities.test.js.

import { handlers, definitions } from "../../src/tools/paragraphs.js";

function setSecurity(s) { siteSecurity = s; }

function canonicalParagraph(over = {}) {
  return {
    id: "p-uuid-1", entityType: "paragraph", bundle: "text", title: null, status: null,
    langcode: "en", created: null, changed: null, url: null,
    fields: { field_body: { value: "Hello", format: "full_html" } },
    relationships: {}, _backend: "jsonapi", ...over,
  };
}

beforeEach(() => {
  setSecurity({});
  Object.values(backend).forEach((f) => f.mockReset());
});

describe("paragraphs tools", () => {
  it("exposes the two governed tool definitions", () => {
    const names = definitions.map((d) => d.name);
    expect(names).toContain("drupal_create_paragraph");
    expect(names).toContain("drupal_get_paragraph");
  });

  it("create_paragraph creates a paragraph entity of the requested bundle", async () => {
    backend.createEntity.mockResolvedValue(canonicalParagraph());
    await handlers.drupal_create_paragraph({
      paragraphType: "text",
      attributes: { field_body: { value: "Hello", format: "full_html" } },
    });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "paragraph", bundle: "text" });
    expect(arg.attributes.field_body).toEqual({ value: "Hello", format: "full_html" });
  });

  it("create_paragraph returns a ref suitable for embedding (id + type)", async () => {
    backend.createEntity.mockResolvedValue(canonicalParagraph());
    const out = await handlers.drupal_create_paragraph({
      paragraphType: "text",
      attributes: { field_body: "x" },
    });
    expect(out.ref).toMatchObject({ id: "p-uuid-1", type: "paragraph--text" });
    expect(out.paragraph).toMatchObject({ id: "p-uuid-1", bundle: "text" });
  });

  it("create_paragraph surfaces a relationship-embedding hint with the field shape", async () => {
    backend.createEntity.mockResolvedValue(canonicalParagraph());
    const out = await handlers.drupal_create_paragraph({ paragraphType: "text", attributes: {} });
    // relationship data the caller drops into a host field via drupal_entity_update relationships
    expect(out.relationshipData).toEqual({ type: "paragraph--text", id: "p-uuid-1" });
    expect(typeof out.note).toBe("string");
    expect(out.note.length).toBeGreaterThan(0);
  });

  it("create_paragraph defaults attributes to an empty object when omitted", async () => {
    backend.createEntity.mockResolvedValue(canonicalParagraph());
    await handlers.drupal_create_paragraph({ paragraphType: "text" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes).toEqual({});
  });

  it("exposes drupal_update_paragraph", () => {
    expect(definitions.map((d) => d.name)).toContain("drupal_update_paragraph");
  });

  it("update_paragraph patches an existing paragraph's field values", async () => {
    backend.updateEntity.mockResolvedValue(canonicalParagraph({ fields: { field_body: { value: "Updated", format: "full_html" } } }));
    const out = await handlers.drupal_update_paragraph({
      paragraphType: "text", id: "p-uuid-1",
      attributes: { field_body: { value: "Updated", format: "full_html" } },
    });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "paragraph", bundle: "text", id: "p-uuid-1" });
    expect(arg.attributes.field_body).toEqual({ value: "Updated", format: "full_html" });
    expect(out.ref).toEqual({ type: "paragraph--text", id: "p-uuid-1" });
    expect(out.relationshipData).toEqual({ type: "paragraph--text", id: "p-uuid-1" });
  });

  it("update_paragraph requires an id", async () => {
    await expect(handlers.drupal_update_paragraph({ paragraphType: "text", attributes: {} }))
      .rejects.toThrow(/id/i);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("update_paragraph is blocked on a read-only policy", async () => {
    setSecurity({ readOnly: true });
    await expect(handlers.drupal_update_paragraph({ paragraphType: "text", id: "p-uuid-1", attributes: { field_body: "x" } }))
      .rejects.toThrow();
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("get_paragraph fetches a paragraph by bundle + UUID", async () => {
    backend.getEntity.mockResolvedValue(canonicalParagraph());
    const out = await handlers.drupal_get_paragraph({ paragraphType: "text", id: "p-uuid-1" });
    expect(backend.getEntity).toHaveBeenCalledWith({ entityType: "paragraph", bundle: "text", id: "p-uuid-1" });
    expect(out.id).toBe("p-uuid-1");
    expect(out.ref).toEqual({ id: "p-uuid-1", type: "paragraph--text" });
  });

  it("get_paragraph returns null when the paragraph is not found", async () => {
    backend.getEntity.mockResolvedValue(null);
    const out = await handlers.drupal_get_paragraph({ paragraphType: "text", id: "missing" });
    expect(out).toBeNull();
  });

  it("create_paragraph is blocked when the policy denies the paragraph entity type", async () => {
    setSecurity({ deniedEntityTypes: ["paragraph"] });
    await expect(handlers.drupal_create_paragraph({ paragraphType: "text", attributes: {} }))
      .rejects.toThrow();
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("get_paragraph is blocked when the policy is read-only-denied for paragraph", async () => {
    setSecurity({ deniedEntityTypes: ["paragraph"] });
    await expect(handlers.drupal_get_paragraph({ paragraphType: "text", id: "p-uuid-1" }))
      .rejects.toThrow();
    expect(backend.getEntity).not.toHaveBeenCalled();
  });

  it("create_paragraph is blocked on a read-only policy", async () => {
    setSecurity({ readOnly: true });
    await expect(handlers.drupal_create_paragraph({ paragraphType: "text", attributes: {} }))
      .rejects.toThrow();
    expect(backend.createEntity).not.toHaveBeenCalled();
  });
});
