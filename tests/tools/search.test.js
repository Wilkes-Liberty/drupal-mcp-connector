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
      readOnly: false, allowedEntityTypes: null, deniedEntityTypes: [], entityRules: {}, globalRedactedFields: [],
    })),
  };
});

import { handlers } from "../../src/tools/search.js";

const node = (over = {}) => ({ id: "n1", entityType: "node", bundle: "article", title: "Hello world",
  langcode: "en", url: "/h", fields: {}, relationships: {}, _backend: "jsonapi", ...over });

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

describe("search tool", () => {
  it("runs a title CONTAINS query and flags fallback mode", async () => {
    backend.listEntities.mockResolvedValue({ entities: [node()], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_search({ query: "hello", type: "article", limit: 5 });
    expect(out.mode).toBe("fallback");
    expect(out.results).toHaveLength(1);
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "node", bundle: "article", page: { limit: 5 } });
    expect(desc.filters).toEqual(expect.arrayContaining([{ field: "title", op: "contains", value: "hello" }]));
  });

  it("rejects an empty query", async () => {
    await expect(handlers.drupal_search({ query: "  " })).rejects.toThrow(/query/i);
    expect(backend.listEntities).not.toHaveBeenCalled();
  });
});
