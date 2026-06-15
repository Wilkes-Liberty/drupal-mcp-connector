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
      readOnly: false, allowDestructive: true, allowGraphqlMutations: true,
      allowedEntityTypes: null, deniedEntityTypes: [], entityRules: {}, globalRedactedFields: [],
    })),
  };
});

import { handlers } from "../../src/tools/moderation.js";

function node(over = {}) {
  return { id: "n1", entityType: "node", bundle: "article", title: "T", status: false,
    langcode: "en", created: null, changed: null, url: "/t", fields: {}, relationships: {}, _backend: "jsonapi", ...over };
}

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

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

  it("content_by_moderation_state filters on moderation_state and pages", async () => {
    backend.listEntities.mockResolvedValue({ entities: [node()], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_content_by_moderation_state({ type: "article", state: "draft", limit: 5 });
    expect(out.total).toBe(1);
    expect(out.state).toBe("draft");
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc.filters).toEqual(expect.arrayContaining([{ field: "moderation_state", op: "eq", value: "draft" }]));
    expect(desc.page).toEqual({ limit: 5, offset: 0 });
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
