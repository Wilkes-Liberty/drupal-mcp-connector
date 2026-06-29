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
// (entity-type-aware), so we exercise the real policy engine (entities/paragraphs pattern).

import { handlers, definitions } from "../../src/tools/redirects.js";

function setSecurity(s) { siteSecurity = s; }

function canonicalRedirect(over = {}) {
  return {
    id: "r-uuid-1", entityType: "redirect", bundle: "redirect", title: null, status: null,
    langcode: "und", created: null, changed: null, url: null,
    fields: {
      redirect_source: { path: "old", query: null },
      redirect_redirect: { uri: "internal:/new" },
      status_code: 301,
    },
    relationships: {}, _backend: "jsonapi", ...over,
  };
}

beforeEach(() => {
  setSecurity({});
  Object.values(backend).forEach((f) => f.mockReset());
});

describe("redirect tools", () => {
  it("exposes the two governed tool definitions", () => {
    const names = definitions.map((d) => d.name).sort();
    expect(names).toEqual(["drupal_create_redirect", "drupal_update_redirect"]);
  });

  // --- create ---------------------------------------------------------------

  it("create_redirect builds an active 301 by default and strips the source leading slash", async () => {
    backend.createEntity.mockResolvedValue(canonicalRedirect());
    await handlers.drupal_create_redirect({ source: "/old-path", target: "/new-path" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "redirect", bundle: "redirect" });
    expect(arg.attributes).toMatchObject({
      redirect_source: { path: "old-path", query: null },
      redirect_redirect: { uri: "internal:/new-path" },
      status_code: 301,
      language: "und",
    });
  });

  it("create_redirect honors an explicit 302 status code", async () => {
    backend.createEntity.mockResolvedValue(canonicalRedirect({ fields: { status_code: 302 } }));
    await handlers.drupal_create_redirect({ source: "old", target: "/new", statusCode: 302 });
    expect(backend.createEntity.mock.calls[0][0].attributes.status_code).toBe(302);
  });

  it("create_redirect passes through entity: and absolute-URL targets unchanged", async () => {
    backend.createEntity.mockResolvedValue(canonicalRedirect());
    await handlers.drupal_create_redirect({ source: "/a", target: "entity:node/42" });
    expect(backend.createEntity.mock.calls[0][0].attributes.redirect_redirect.uri).toBe("entity:node/42");

    backend.createEntity.mockResolvedValue(canonicalRedirect());
    await handlers.drupal_create_redirect({ source: "/b", target: "https://example.com/x" });
    expect(backend.createEntity.mock.calls[1][0].attributes.redirect_redirect.uri).toBe("https://example.com/x");
  });

  it("create_redirect rejects an unsupported status code", async () => {
    await expect(handlers.drupal_create_redirect({ source: "/a", target: "/b", statusCode: 200 }))
      .rejects.toThrow(/status code/i);
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  it("create_redirect requires source and target", async () => {
    await expect(handlers.drupal_create_redirect({ target: "/b" })).rejects.toThrow(/source/i);
    await expect(handlers.drupal_create_redirect({ source: "/a" })).rejects.toThrow(/target/i);
  });

  it("create_redirect is blocked when the policy forbids redirect writes", async () => {
    setSecurity({ preset: "production-strict" });
    await expect(handlers.drupal_create_redirect({ source: "/a", target: "/b" })).rejects.toThrow();
    expect(backend.createEntity).not.toHaveBeenCalled();
  });

  // --- update ---------------------------------------------------------------

  it("update_redirect patches only the provided fields (partial update)", async () => {
    backend.updateEntity.mockResolvedValue(canonicalRedirect({ fields: { status_code: 302 } }));
    await handlers.drupal_update_redirect({ id: "r-uuid-1", statusCode: 302 });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "redirect", bundle: "redirect", id: "r-uuid-1" });
    expect(arg.attributes).toEqual({ status_code: 302 });
  });

  it("update_redirect normalizes a new source/target when repointing", async () => {
    backend.updateEntity.mockResolvedValue(canonicalRedirect());
    await handlers.drupal_update_redirect({ id: "r-uuid-1", source: "/moved", target: "/dest" });
    const attrs = backend.updateEntity.mock.calls[0][0].attributes;
    expect(attrs.redirect_source).toEqual({ path: "moved", query: null });
    expect(attrs.redirect_redirect).toEqual({ uri: "internal:/dest" });
    expect(attrs.status_code).toBeUndefined();
  });

  it("update_redirect requires id", async () => {
    await expect(handlers.drupal_update_redirect({ statusCode: 301 })).rejects.toThrow(/id/i);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });
});
