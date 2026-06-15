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
      readOnly: false, allowedEntityTypes: null, deniedEntityTypes: [],
      globalRedactedFields: [], entityRules: {},
    })),
  };
});

import { handlers, definitions } from "../../src/tools/references.js";

function canonicalNode(over = {}) {
  return { id: "n1", entityType: "node", bundle: "article", title: "Hello World", status: true,
    langcode: "en", created: null, changed: null, url: "/hello-world", fields: { body: { value: "B" } },
    relationships: {}, _backend: "jsonapi", ...over };
}
function canonicalTerm(over = {}) {
  return { id: "t1", entityType: "taxonomy_term", bundle: "tags", title: null, status: true,
    langcode: "en", created: null, changed: null, url: null, fields: { name: "News" },
    relationships: {}, _backend: "jsonapi", ...over };
}

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

describe("references tools", () => {
  it("exposes a drupal_resolve_reference definition with the required inputs", () => {
    const def = definitions.find((d) => d.name === "drupal_resolve_reference");
    expect(def).toBeTruthy();
    expect(def.inputSchema.required).toEqual(expect.arrayContaining(["entityType", "bundle", "name"]));
  });

  it("uses a title-contains filter for nodes", async () => {
    backend.listEntities.mockResolvedValue({ entities: [canonicalNode()], page: { total: 1 }, approximate: false });
    await handlers.drupal_resolve_reference({ entityType: "node", bundle: "article", name: "Hello" });
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "node", bundle: "article" });
    expect(desc.filters).toEqual(expect.arrayContaining([{ field: "title", op: "contains", value: "Hello" }]));
  });

  it("uses a name-contains filter for taxonomy_term", async () => {
    backend.listEntities.mockResolvedValue({ entities: [canonicalTerm()], page: { total: 1 }, approximate: false });
    await handlers.drupal_resolve_reference({ entityType: "taxonomy_term", bundle: "tags", name: "News" });
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc.filters).toEqual(expect.arrayContaining([{ field: "name", op: "contains", value: "News" }]));
  });

  it("uses a name-contains filter for user", async () => {
    backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
    await handlers.drupal_resolve_reference({ entityType: "user", bundle: "user", name: "alice" });
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc.filters).toEqual(expect.arrayContaining([{ field: "name", op: "contains", value: "alice" }]));
  });

  it("returns the best match {id,title} for a node", async () => {
    backend.listEntities.mockResolvedValue({ entities: [canonicalNode()], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_resolve_reference({ entityType: "node", bundle: "article", name: "Hello World" });
    expect(out.resolved).toBe(true);
    expect(out.match).toEqual({ id: "n1", title: "Hello World" });
    expect(out.ambiguous).toBe(false);
    expect(out.candidates).toEqual([{ id: "n1", title: "Hello World" }]);
  });

  it("derives the label from fields.name for taxonomy_term", async () => {
    backend.listEntities.mockResolvedValue({ entities: [canonicalTerm()], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_resolve_reference({ entityType: "taxonomy_term", bundle: "tags", name: "News" });
    expect(out.match).toEqual({ id: "t1", title: "News" });
  });

  it("prefers an exact (case-insensitive) match over a partial one", async () => {
    backend.listEntities.mockResolvedValue({
      entities: [
        canonicalNode({ id: "n2", title: "Hello World Today" }),
        canonicalNode({ id: "n1", title: "hello world" }),
      ],
      page: { total: 2 }, approximate: false,
    });
    const out = await handlers.drupal_resolve_reference({ entityType: "node", bundle: "article", name: "Hello World" });
    expect(out.match.id).toBe("n1");
  });

  it("reports ambiguous candidates when no exact match and multiple results", async () => {
    backend.listEntities.mockResolvedValue({
      entities: [
        canonicalNode({ id: "n1", title: "Hello World Today" }),
        canonicalNode({ id: "n2", title: "Hello World Tomorrow" }),
      ],
      page: { total: 2 }, approximate: false,
    });
    const out = await handlers.drupal_resolve_reference({ entityType: "node", bundle: "article", name: "Hello" });
    expect(out.resolved).toBe(true);
    expect(out.ambiguous).toBe(true);
    expect(out.match.id).toBe("n1");
    expect(out.candidates).toEqual([
      { id: "n1", title: "Hello World Today" },
      { id: "n2", title: "Hello World Tomorrow" },
    ]);
  });

  it("returns resolved:false with no match when nothing is found", async () => {
    backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
    const out = await handlers.drupal_resolve_reference({ entityType: "node", bundle: "article", name: "Nope" });
    expect(out.resolved).toBe(false);
    expect(out.match).toBeNull();
    expect(out.candidates).toEqual([]);
  });

  it("redacts read results before deriving labels", async () => {
    const sec = await import("../../src/lib/security.js");
    sec.resolveSecurityConfig.mockReturnValueOnce({
      readOnly: false, allowedEntityTypes: null, deniedEntityTypes: [],
      globalRedactedFields: ["name"], entityRules: {},
    });
    backend.listEntities.mockResolvedValue({ entities: [canonicalTerm()], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_resolve_reference({ entityType: "taxonomy_term", bundle: "tags", name: "News" });
    expect(out.match.title).toBe("[REDACTED]");
  });

  it("blocks reads disallowed by the security policy", async () => {
    const sec = await import("../../src/lib/security.js");
    sec.resolveSecurityConfig.mockReturnValueOnce({
      readOnly: true, allowedEntityTypes: ["node"], deniedEntityTypes: ["user"], entityRules: {}, globalRedactedFields: [],
    });
    await expect(
      handlers.drupal_resolve_reference({ entityType: "user", bundle: "user", name: "alice" })
    ).rejects.toThrow();
    expect(backend.listEntities).not.toHaveBeenCalled();
  });
});
