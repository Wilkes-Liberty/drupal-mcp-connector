import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(), getEntity: vi.fn(), createEntity: vi.fn(), updateEntity: vi.fn(),
  deleteEntity: vi.fn(), listBundles: vi.fn(), uploadFile: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return { ...actual, resolveSecurityConfig: vi.fn(() => ({ globalRedactedFields: [], entityRules: {} })) };
});

import { handlers } from "../../src/tools/media.js";

const media = { id: "m1", entityType: "media", bundle: "image", title: null, status: true,
  langcode: "en", created: null, changed: null, url: null, fields: { name: "Pic" }, relationships: {}, _backend: "jsonapi" };

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

describe("media tools (migrated)", () => {
  it("list_media_types uses listBundles", async () => {
    backend.listBundles.mockResolvedValue([{ id: "image", label: "Image", description: null }]);
    const out = await handlers.drupal_list_media_types({});
    expect(out).toEqual([{ id: "image", label: "Image", description: null }]);
    expect(backend.listBundles).toHaveBeenCalledWith("media");
  });

  it("list_media compiles status + name filters", async () => {
    backend.listEntities.mockResolvedValue({ entities: [media], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_list_media({ type: "image", status: true, name: "pic", limit: 5 });
    expect(out.total).toBe(1);
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "media", bundle: "image", page: { limit: 5, offset: 0 } });
    expect(desc.filters).toEqual(expect.arrayContaining([
      { field: "status", op: "eq", value: true },
      { field: "name", op: "contains", value: "pic" },
    ]));
  });

  it("create_media builds attributes and calls createEntity", async () => {
    backend.createEntity.mockResolvedValue(media);
    await handlers.drupal_create_media({ type: "image", name: "Pic", status: true, fields: { field_media_image: { data: {} } } });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "media", bundle: "image" });
    expect(arg.attributes.name).toBe("Pic");
    expect(arg.attributes.status).toBe(true);
  });

  it("get_media returns the canonical media or null", async () => {
    backend.getEntity.mockResolvedValue(media);
    const out = await handlers.drupal_get_media({ type: "image", id: "m1" });
    expect(out.id).toBe("m1");
    expect(backend.getEntity).toHaveBeenCalledWith({ entityType: "media", bundle: "image", id: "m1" });
    backend.getEntity.mockResolvedValue(null);
    expect(await handlers.drupal_get_media({ type: "image", id: "gone" })).toBeNull();
  });

  it("update_media sets name/status conditionally and calls updateEntity", async () => {
    backend.updateEntity.mockResolvedValue(media);
    await handlers.drupal_update_media({ type: "image", id: "m1", name: "Renamed", fields: { field_x: 1 } });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "media", bundle: "image", id: "m1" });
    expect(arg.attributes.name).toBe("Renamed");
    expect(arg.attributes.field_x).toBe(1);
    expect(arg.attributes).not.toHaveProperty("status");
  });

  it("delete_media calls deleteEntity", async () => {
    backend.deleteEntity.mockResolvedValue(undefined);
    const out = await handlers.drupal_delete_media({ type: "image", id: "m1" });
    expect(out).toEqual({ success: true, deletedId: "m1" });
  });

  it("upload_file delegates to backend.uploadFile", async () => {
    backend.uploadFile.mockResolvedValue({ id: "f1", filename: "x.jpg" });
    const out = await handlers.drupal_upload_file({ bundle: "image", fieldName: "field_media_image", filePath: "/tmp/x.jpg" });
    expect(out.id).toBe("f1");
    expect(backend.uploadFile).toHaveBeenCalledWith({ entityType: "media", bundle: "image", fieldName: "field_media_image", filePath: "/tmp/x.jpg" });
  });

  it("upload_file_and_create_media uploads then creates media with a file relationship", async () => {
    backend.uploadFile.mockResolvedValue({ id: "f1", filename: "x.jpg" });
    backend.createEntity.mockResolvedValue(media);
    const out = await handlers.drupal_upload_file_and_create_media({ filePath: "/tmp/x.jpg", mediaType: "image", fieldName: "field_media_image", altText: "alt" });
    expect(out.file.id).toBe("f1");
    expect(out.media.id).toBe("m1");
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.relationships.field_media_image.data).toEqual({ type: "file--file", id: "f1", meta: { alt: "alt" } });
  });

  it("find_orphaned_media falls back to listing all on filter error", async () => {
    backend.listEntities
      .mockRejectedValueOnce(new Error("no such field field_usage_count"))
      .mockResolvedValueOnce({ entities: [media], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_find_orphaned_media({ type: "image" });
    expect(out.method).toMatch(/no_usage_tracking|all_media/);
    expect(out.count).toBe(1);
  });
});
