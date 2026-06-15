import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  listEntities: vi.fn(),
  getEntity: vi.fn(),
  createEntity: vi.fn(),
  updateEntity: vi.fn(),
  deleteEntity: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveSecurityConfig: vi.fn(() => ({ globalRedactedFields: [], entityRules: {} })),
    assertWriteAllowed: vi.fn(),
  };
});

import { handlers } from "../../src/tools/bulk.js";
import { assertWriteAllowed } from "../../src/lib/security.js";

beforeEach(() => {
  Object.values(backend).forEach((f) => f.mockReset());
  assertWriteAllowed.mockReset();
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
});
