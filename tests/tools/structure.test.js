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
  // Governed handlers assert against the resolved config, so delegate to the
  // real resolver (over a permissive empty policy) to produce a full config.
  return { ...actual, resolveSecurityConfig: vi.fn((site) => actual.resolveSecurityConfig(site)) };
});

import { handlers, definitions } from "../../src/tools/structure.js";

function canonicalMenuLink(over = {}) {
  return {
    id: "ml1", entityType: "menu_link_content", bundle: "menu_link_content",
    title: "Home", status: true, langcode: "en", created: null, changed: null,
    url: null, fields: { link: { uri: "internal:/", title: "" }, menu_name: "main", weight: 0 },
    relationships: {}, _backend: "jsonapi", ...over,
  };
}

function canonicalBlock(over = {}) {
  return {
    id: "b1", entityType: "block_content", bundle: "basic",
    title: null, status: true, langcode: "en", created: null, changed: null,
    url: null, fields: { info: "Promo", body: { value: "<p>hi</p>", format: "full_html" } },
    relationships: {}, _backend: "jsonapi", ...over,
  };
}

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

describe("structure tools", () => {
  it("exposes the four expected tool definitions", () => {
    const names = definitions.map((d) => d.name).sort();
    expect(names).toEqual([
      "drupal_create_block",
      "drupal_create_menu_link",
      "drupal_list_blocks",
      "drupal_list_menu_links",
    ]);
  });

  // --- menu links -----------------------------------------------------------

  it("list_menu_links lists menu_link_content with no menu filter", async () => {
    backend.listEntities.mockResolvedValue({ entities: [canonicalMenuLink()], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_list_menu_links({});
    expect(out.total).toBe(1);
    expect(out.menuLinks[0].id).toBe("ml1");
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "menu_link_content", bundle: "menu_link_content" });
    expect(desc.filters).toEqual([]);
  });

  it("list_menu_links applies a menu_name filter when menu is given", async () => {
    backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
    await handlers.drupal_list_menu_links({ menu: "main" });
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc.filters).toEqual([{ field: "menu_name", op: "eq", value: "main" }]);
  });

  it("list_menu_links returns offset/nextOffset pagination state", async () => {
    backend.listEntities.mockResolvedValue({ entities: [canonicalMenuLink(), canonicalMenuLink({ id: "ml2" })], page: { total: 7 }, approximate: false });
    const out = await handlers.drupal_list_menu_links({ offset: 5 });
    expect(out.total).toBe(7);
    expect(out.offset).toBe(5);
    expect(out.nextOffset).toBe(7);
  });

  it("create_menu_link builds the link.uri wrapper and calls createEntity", async () => {
    backend.createEntity.mockResolvedValue(canonicalMenuLink());
    await handlers.drupal_create_menu_link({ title: "Home", link: "internal:/", menu: "main", weight: 3 });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "menu_link_content", bundle: "menu_link_content" });
    expect(arg.attributes.title).toBe("Home");
    expect(arg.attributes.link).toEqual({ uri: "internal:/" });
    expect(arg.attributes.menu_name).toBe("main");
    expect(arg.attributes.weight).toBe(3);
  });

  it("create_menu_link defaults weight to 0 when omitted", async () => {
    backend.createEntity.mockResolvedValue(canonicalMenuLink());
    await handlers.drupal_create_menu_link({ title: "Home", link: "internal:/", menu: "main" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes.weight).toBe(0);
  });

  // --- blocks ---------------------------------------------------------------

  it("list_blocks lists block_content with no type filter", async () => {
    backend.listEntities.mockResolvedValue({ entities: [canonicalBlock()], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_list_blocks({});
    expect(out.total).toBe(1);
    expect(out.blocks[0].id).toBe("b1");
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "block_content" });
    expect(desc.bundle).toBeUndefined();
  });

  it("list_blocks scopes the bundle when type is given", async () => {
    backend.listEntities.mockResolvedValue({ entities: [], page: { total: 0 }, approximate: false });
    await handlers.drupal_list_blocks({ type: "basic" });
    const desc = backend.listEntities.mock.calls[0][0];
    expect(desc).toMatchObject({ entityType: "block_content", bundle: "basic" });
  });

  it("create_block builds the body wrapper and calls createEntity", async () => {
    backend.createEntity.mockResolvedValue(canonicalBlock());
    await handlers.drupal_create_block({ type: "basic", info: "Promo", body: "<p>hi</p>" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "block_content", bundle: "basic" });
    expect(arg.attributes.info).toBe("Promo");
    expect(arg.attributes.body).toEqual({ value: "<p>hi</p>", format: "full_html" });
  });

  it("create_block omits body when none is supplied", async () => {
    backend.createEntity.mockResolvedValue(canonicalBlock());
    await handlers.drupal_create_block({ type: "basic", info: "Empty" });
    const arg = backend.createEntity.mock.calls[0][0];
    expect(arg.attributes.info).toBe("Empty");
    expect(arg.attributes).not.toHaveProperty("body");
  });

  // --- redaction ------------------------------------------------------------

  it("list_menu_links redacts read results per policy", async () => {
    backend.listEntities.mockResolvedValue({ entities: [canonicalMenuLink()], page: { total: 1 }, approximate: false });
    const out = await handlers.drupal_list_menu_links({});
    // canonical shape preserved (mock policy redacts nothing)
    expect(out.menuLinks[0]).toHaveProperty("fields");
  });
});
