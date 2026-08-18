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
    resolveSecurityConfig: vi.fn(() => ({
      readOnly: false, allowDestructive: true, allowGraphqlMutations: true, allowPublish: true,
      allowedEntityTypes: null, deniedEntityTypes: [], entityRules: {}, globalRedactedFields: [],
    })),
  };
});

import { handlers } from "../../src/tools/moderation.js";

function node(over = {}) {
  return { id: "n1", entityType: "node", bundle: "article", title: "T", status: false,
    langcode: "en", created: null, changed: null, url: "/t", fields: {}, relationships: {}, _backend: "jsonapi", ...over };
}

beforeEach(() => {
  Object.values(backend).forEach((f) => {
    if (typeof f.mockReset === "function") f.mockReset();
  });
});

describe("moderation tools", () => {
  it("set_moderation_state writes moderation_state via updateEntity", async () => {
    backend.updateEntity.mockResolvedValue(node());
    await handlers.drupal_set_moderation_state({ type: "article", id: "n1", state: "published" });
    expect(backend.updateEntity).toHaveBeenCalledWith({ entityType: "node", bundle: "article", id: "n1", attributes: { moderation_state: "published" } });
  });

  it("set_moderation_state requires a state", async () => {
    await expect(handlers.drupal_set_moderation_state({ type: "article", id: "n1" })).rejects.toThrow(/state/i);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("content_by_moderation_state uses a server-side filter when the site accepts it", async () => {
    backend.capabilities = () => ({ filter: true });
    backend.listEntities.mockResolvedValue({ entities: [node({ fields: { moderation_state: "draft" } })], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_content_by_moderation_state({ type: "article", state: "draft", limit: 5 });
    expect(out.total).toBe(1);
    expect(out.state).toBe("draft");
    expect(out.source).toBe("filter");
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc.filters).toEqual(expect.arrayContaining([{ field: "moderation_state", op: "eq", value: "draft" }]));
    expect(desc.page).toEqual({ limit: 5, offset: 0 });
  });

  it("content_by_moderation_state samples client-side when JSON:API cannot filter the field (#162)", async () => {
    backend.capabilities = () => ({ filter: true });
    backend.listEntities
      .mockRejectedValueOnce(new Error(
        "Drupal 500 on GET /jsonapi/node/article?filter[moderation_state]=draft: 'moderation_state' not found",
      ))
      .mockResolvedValue({
        entities: [
          node({ id: "d1", fields: { moderation_state: "draft" } }),
          node({ id: "p1", fields: { moderation_state: "published" } }),
          node({ id: "d2", fields: { moderation_state: { value: "draft" } } }),
        ],
        page: { total: 3, hasNext: false },
      });
    const out = await handlers.drupal_content_by_moderation_state({ type: "article", state: "draft", limit: 10 });
    expect(out.source).toBe("sampled");
    expect(out.nodes.map((n) => n.id)).toEqual(["d1", "d2"]);
    expect(out.total).toBe(2);
    expect(out.approximate).toBe(false);
    expect(out.note).toMatch(/cannot filter/i);
    const fallback = backend.listEntities.mock.calls[1][0];
    expect(fallback.filters ?? []).toEqual([]);
  });

  it("content_by_moderation_state returns a gated payload when the field is absent, not a 500 (#162)", async () => {
    backend.capabilities = () => ({ filter: true });
    backend.listEntities
      .mockRejectedValueOnce(new Error(
        "Drupal 500 on GET /jsonapi/node/article?filter[moderation_state]=draft: 'moderation_state' not found",
      ))
      .mockResolvedValue({ entities: [node({ fields: {} })], page: { hasNext: false } });
    const out = await handlers.drupal_content_by_moderation_state({ type: "article", state: "draft" });
    expect(out.unavailable).toBe(true);
    expect(out.reason).toMatch(/not filterable/i);
  });

  it("content_by_moderation_state treats an empty bundle as an empty sample, not unavailable (#162)", async () => {
    backend.capabilities = () => ({ filter: true });
    backend.listEntities
      .mockRejectedValueOnce(new Error(
        "Drupal 500 on GET /jsonapi/node/article?filter[moderation_state]=draft: 'moderation_state' not found",
      ))
      .mockResolvedValue({ entities: [], page: { hasNext: false } });
    const out = await handlers.drupal_content_by_moderation_state({ type: "article", state: "draft" });
    expect(out.unavailable).toBeUndefined();
    expect(out.source).toBe("sampled");
    expect(out.nodes).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("content_by_moderation_state still throws an unrelated Drupal error", async () => {
    backend.capabilities = () => ({ filter: true });
    backend.listEntities.mockRejectedValue(new Error("Drupal 500 on GET /jsonapi/node/article: SQLSTATE[HY000]"));
    await expect(handlers.drupal_content_by_moderation_state({ type: "article", state: "draft" }))
      .rejects.toThrow(/SQLSTATE/);
  });

  it("list_moderation_states returns distinct observed states (non-authoritative)", async () => {
    backend.listEntities.mockResolvedValue({ entities: [
      node({ fields: { moderation_state: "draft" } }),
      node({ fields: { moderation_state: "published" } }),
      node({ fields: { moderation_state: "draft" } }),
    ], page: { total: 3 }, approximate: false });
    const out = await handlers.drupal_list_moderation_states({ type: "article" });
    expect(out.states).toEqual(["draft", "published"]);
    expect(out.authoritative).toBe(false);
  });
});
