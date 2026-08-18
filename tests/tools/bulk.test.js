import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(),
  getEntity: vi.fn(),
  createEntity: vi.fn(),
  updateEntity: vi.fn(),
  deleteEntity: vi.fn(),
  rawQuery: vi.fn(),
  resourcePath: vi.fn((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    // Development-like defaults: writes allowed; publish allowed so tests can
    // pass explicit moderation_state:published (#139 gate) without per-test sites.
    resolveSecurityConfig: vi.fn(() => ({
      readOnly: false, allowPublish: true, allowDestructive: true,
      allowedEntityTypes: null, deniedEntityTypes: [],
      globalRedactedFields: [], entityRules: {},
    })),
    assertWriteAllowed: vi.fn(),
  };
});

import { handlers } from "../../src/tools/bulk.js";
import { assertWriteAllowed, resolveSecurityConfig } from "../../src/lib/security.js";

const openSec = () => ({
  readOnly: false, allowPublish: true, allowDestructive: true,
  allowedEntityTypes: null, deniedEntityTypes: [],
  globalRedactedFields: [], entityRules: {},
});

beforeEach(() => {
  Object.values(backend).forEach((f) => f.mockReset());
  backend.rawQuery.mockRejectedValue(new Error(
    "Drupal 400 on PATCH /jsonapi/node/article/n1: The selected entity (n1) " +
    "does not match the ID in the payload (00000000-0000-4000-a000-000000000001)."
  ));
  backend.resourcePath.mockImplementation((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`);
  assertWriteAllowed.mockReset();
  resolveSecurityConfig.mockReset();
  resolveSecurityConfig.mockImplementation(() => openSec());
});

describe("bulk tools", () => {
  it("bulk_create creates each item and returns per-item results plus summary", async () => {
    backend.createEntity
      .mockResolvedValueOnce({ id: "a1" })
      .mockResolvedValueOnce({ id: "a2" });
    const out = await handlers.drupal_bulk_create({
      entityType: "node", bundle: "article",
      items: [{ attributes: { title: "One" } }, { attributes: { title: "Two" } }],
    });
    expect(out.results).toEqual([
      { index: 0, success: true, id: "a1" },
      { index: 1, success: true, id: "a2" },
    ]);
    expect(out.summary).toEqual({ created: 2, failed: 0 });
    expect(backend.createEntity).toHaveBeenCalledTimes(2);
    expect(backend.createEntity).toHaveBeenNthCalledWith(1, {
      entityType: "node", bundle: "article", attributes: { title: "One" }, relationships: {},
    });
  });

  it("gates a publish-bearing item per-item without aborting the batch (#111/#114)", async () => {
    // Explicit no-publish policy for this case (#139: status:true is publish-bearing).
    resolveSecurityConfig.mockImplementation(() => ({ ...openSec(), allowPublish: false }));
    backend.updateEntity.mockResolvedValue({ id: "n2" });
    const out = await handlers.drupal_bulk_update({
      entityType: "node", bundle: "article",
      items: [
        { id: "11111111-1111-4111-8111-111111111111", attributes: { status: true } },
        { id: "22222222-2222-4222-8222-222222222222", attributes: { title: "ok" } },
      ],
    });
    expect(out.summary).toMatchObject({ updated: 1, failed: 1 });
    expect(out.results.find((r) => !r.success).error).toMatch(/allowPublish/);
    // The publish-bearing item never reached the backend; the other one did.
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
  });

  it("bulk_create continues past a per-item failure (partial success)", async () => {
    backend.createEntity
      .mockResolvedValueOnce({ id: "a1" })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ id: "a3" });
    const out = await handlers.drupal_bulk_create({
      entityType: "node", bundle: "article",
      items: [{ attributes: { title: "One" } }, { attributes: { title: "Bad" } }, { attributes: { title: "Three" } }],
    });
    expect(out.results[0]).toEqual({ index: 0, success: true, id: "a1" });
    expect(out.results[1]).toEqual({ index: 1, success: false, error: "boom" });
    expect(out.results[2]).toEqual({ index: 2, success: true, id: "a3" });
    expect(out.summary).toEqual({ created: 2, failed: 1 });
  });

  it("bulk_create passes relationships when provided", async () => {
    backend.createEntity.mockResolvedValue({ id: "a1" });
    await handlers.drupal_bulk_create({
      entityType: "node", bundle: "article",
      items: [{ attributes: { title: "One" }, relationships: { field_author: { data: { type: "user", id: "u1" } } } }],
    });
    expect(backend.createEntity).toHaveBeenCalledWith({
      entityType: "node", bundle: "article",
      attributes: { title: "One" },
      relationships: { field_author: { data: { type: "user", id: "u1" } } },
    });
  });

  it("bulk_create asserts write permission exactly once", async () => {
    backend.createEntity.mockResolvedValue({ id: "a1" });
    await handlers.drupal_bulk_create({
      entityType: "node", bundle: "article",
      items: [{ attributes: { title: "One" } }, { attributes: { title: "Two" } }],
    });
    expect(assertWriteAllowed).toHaveBeenCalledTimes(1);
    expect(assertWriteAllowed).toHaveBeenCalledWith(expect.anything(), "create", "node", "article");
  });

  it("bulk_create throws (no loop) when write permission is denied", async () => {
    assertWriteAllowed.mockImplementationOnce(() => { throw new Error("denied"); });
    await expect(handlers.drupal_bulk_create({
      entityType: "node", bundle: "article", items: [{ attributes: { title: "One" } }],
    })).rejects.toThrow("denied");
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("bulk_update updates each item by id and returns per-item results plus summary", async () => {
    backend.getEntity.mockResolvedValue({ status: false, fields: {} });
    backend.updateEntity
      .mockResolvedValueOnce({ id: "a1" })
      .mockResolvedValueOnce({ id: "a2" });
    const out = await handlers.drupal_bulk_update({
      entityType: "node", bundle: "article",
      items: [{ id: "a1", attributes: { title: "X" } }, { id: "a2", attributes: { title: "Y" } }],
    });
    expect(out.results).toEqual([
      { index: 0, success: true, id: "a1" },
      { index: 1, success: true, id: "a2" },
    ]);
    expect(out.summary).toEqual({ updated: 2, failed: 0 });
    expect(backend.updateEntity).toHaveBeenNthCalledWith(1, {
      entityType: "node", bundle: "article", id: "a1", attributes: { title: "X" }, relationships: {},
    });
  });

  it("bulk_update defaults published moderated items to draft (#131)", async () => {
    backend.getEntity.mockResolvedValue({
      status: true,
      fields: { moderation_state: "published" },
    });
    backend.updateEntity.mockResolvedValue({ id: "a1" });
    await handlers.drupal_bulk_update({
      entityType: "node", bundle: "article",
      items: [{ id: "a1", attributes: { title: "Wire refs" } }],
    });
    expect(backend.updateEntity).toHaveBeenCalledWith({
      entityType: "node", bundle: "article", id: "a1",
      attributes: { title: "Wire refs", moderation_state: "draft" },
      relationships: {},
    });
  });

  it("bulk_update respects an explicit moderation_state on items (#131)", async () => {
    backend.getEntity.mockResolvedValue({
      status: true,
      fields: { moderation_state: "published" },
    });
    backend.updateEntity.mockResolvedValue({ id: "a1" });
    await handlers.drupal_bulk_update({
      entityType: "node", bundle: "article",
      items: [{ id: "a1", attributes: { title: "Live save", moderation_state: "published" } }],
    });
    expect(backend.updateEntity).toHaveBeenCalledWith({
      entityType: "node", bundle: "article", id: "a1",
      attributes: { title: "Live save", moderation_state: "published" },
      relationships: {},
    });
    // Explicit state short-circuits the capability sniff.
    expect(backend.getEntity).not.toHaveBeenCalled();
  });

  it("bulk_update continues past a per-item failure (partial success)", async () => {
    backend.updateEntity
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce({ id: "a2" });
    const out = await handlers.drupal_bulk_update({
      entityType: "node", bundle: "article",
      items: [{ id: "a1", attributes: { title: "X" } }, { id: "a2", attributes: { title: "Y" } }],
    });
    expect(out.results[0]).toEqual({ index: 0, success: false, error: "nope" });
    expect(out.results[1]).toEqual({ index: 1, success: true, id: "a2" });
    expect(out.summary).toEqual({ updated: 1, failed: 1 });
  });

  it("bulk_update reports a per-item error when id is missing instead of throwing", async () => {
    const out = await handlers.drupal_bulk_update({
      entityType: "node", bundle: "article",
      items: [{ attributes: { title: "X" } }],
    });
    expect(out.results[0].success).toBe(false);
    expect(out.results[0].index).toBe(0);
    expect(out.summary).toEqual({ updated: 0, failed: 1 });
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("bulk_update asserts write permission exactly once", async () => {
    backend.updateEntity.mockResolvedValue({ id: "a1" });
    await handlers.drupal_bulk_update({
      entityType: "node", bundle: "article",
      items: [{ id: "a1", attributes: { title: "X" } }, { id: "a2", attributes: { title: "Y" } }],
    });
    expect(assertWriteAllowed).toHaveBeenCalledTimes(1);
    expect(assertWriteAllowed).toHaveBeenCalledWith(expect.anything(), "update", "node", "article");
  });

  it("definitions are exported and importable", async () => {
    const mod = await import("../../src/tools/bulk.js");
    const names = mod.definitions.map((d) => d.name);
    expect(names).toContain("drupal_bulk_create");
    expect(names).toContain("drupal_bulk_update");
  });

  it("bulk_update probes unpublished moderated hosts via the pre-read entity", async () => {
    backend.getEntity.mockResolvedValue({
      status: false,
      fields: { moderation_state: "draft" },
    });
    backend.updateEntity.mockResolvedValue({ id: "a1" });
    await handlers.drupal_bulk_update({
      entityType: "node", bundle: "article",
      items: [{ id: "a1", attributes: { title: "Draft edit" } }],
    });
    expect(backend.rawQuery).toHaveBeenCalledTimes(1);
    expect(backend.updateEntity).toHaveBeenCalled();
  });

  it("bulk_create of paragraphs returns relationshipData with revision meta (#192)", async () => {
    backend.createEntity.mockResolvedValue({
      id: "p1", entityType: "paragraph", bundle: "capability",
      fields: { drupal_internal__revision_id: 21 },
    });
    const out = await handlers.drupal_bulk_create({
      entityType: "paragraph", bundle: "capability",
      items: [{ attributes: { field_title: "One" } }],
    });
    expect(out.results[0]).toMatchObject({
      index: 0, success: true, id: "p1",
      relationshipData: {
        type: "paragraph--capability", id: "p1", meta: { target_revision_id: 21 },
      },
    });
  });
});

describe("#171 bulk updates keep status opt-in", () => {
  it("a relationships-only bulk item sends neither status nor moderation_state", async () => {
    backend.getEntity.mockResolvedValue({ id: "u1", entityType: "media", bundle: "video_file", status: true, fields: {} });
    backend.updateEntity.mockResolvedValue({ id: "u1" });
    const out = await handlers.drupal_bulk_update({
      entityType: "media", bundle: "video_file",
      items: [{ id: "u1", relationships: { field_poster: { data: { type: "media--image", id: "u2" } } } }],
    });
    expect(out.summary).toEqual({ updated: 1, failed: 0 });
    const sent = backend.updateEntity.mock.calls[0][0];
    expect(sent.attributes).not.toHaveProperty("status");
    expect(sent.attributes).not.toHaveProperty("moderation_state");
  });
});
