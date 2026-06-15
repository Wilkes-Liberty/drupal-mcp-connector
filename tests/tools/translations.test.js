import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  getEntity: vi.fn(),
  updateEntity: vi.fn(),
  rawQuery: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
// Use the REAL security layer (handlers call assertReadAllowed/assertWriteAllowed);
// site.security = {} resolves to the permissive "development" preset.

import { handlers, definitions } from "../../src/tools/translations.js";

const UUID = "11111111-2222-3333-4444-555555555555";

function rawEntity(over = {}) {
  return {
    data: {
      type: "node--article",
      id: UUID,
      attributes: {
        title: "Hello",
        langcode: "en",
        status: true,
        body: { value: "B", format: "full_html", summary: "" },
        ...over,
      },
      links: { self: { href: "https://x/jsonapi/node/article/" + UUID } },
    },
  };
}

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

describe("translations tools", () => {
  it("exposes the two governed tools with correct required params", () => {
    const names = definitions.map((d) => d.name).sort();
    expect(names).toEqual(["drupal_create_translation", "drupal_list_translations"]);

    const list = definitions.find((d) => d.name === "drupal_list_translations");
    expect(list.inputSchema.required).toEqual(expect.arrayContaining(["type", "id"]));

    const create = definitions.find((d) => d.name === "drupal_create_translation");
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(["type", "id", "langcode"]));
  });

  it("list_translations defaults entityType to node and reports the current langcode", async () => {
    backend.rawQuery.mockResolvedValue(rawEntity());
    const out = await handlers.drupal_list_translations({ type: "article", id: UUID });

    // It must read the entity through the validated backend rawQuery (not bypass it).
    expect(backend.rawQuery).toHaveBeenCalledTimes(1);
    const path = backend.rawQuery.mock.calls[0][0].path;
    expect(path).toBe(`/jsonapi/node/article/${UUID}`);

    expect(out.id).toBe(UUID);
    expect(out.entityType).toBe("node");
    expect(out.bundle).toBe("article");
    expect(out.defaultLangcode).toBe("en");
    expect(out.langcodes).toEqual(["en"]);
    expect(out.translations).toEqual([{ langcode: "en", default: true }]);
  });

  it("list_translations supports a non-node entityType", async () => {
    backend.rawQuery.mockResolvedValue(rawEntity({ langcode: "de" }));
    await handlers.drupal_list_translations({ entityType: "taxonomy_term", type: "tags", id: UUID });
    expect(backend.rawQuery.mock.calls[0][0].path).toBe(`/jsonapi/taxonomy_term/tags/${UUID}`);
  });

  it("list_translations returns null-ish shape when the entity is missing", async () => {
    backend.rawQuery.mockResolvedValue({ data: null });
    const out = await handlers.drupal_list_translations({ type: "article", id: UUID });
    expect(out).toBeNull();
  });

  it("list_translations validates the id (rejects non-UUID)", async () => {
    await expect(
      handlers.drupal_list_translations({ type: "article", id: "not-a-uuid" })
    ).rejects.toThrow();
    expect(backend.rawQuery).not.toHaveBeenCalled();
  });

  it("create_translation is a governed write: PATCHes langcode + attributes via updateEntity", async () => {
    backend.updateEntity.mockResolvedValue({ id: UUID, entityType: "node", bundle: "article", langcode: "de" });
    const out = await handlers.drupal_create_translation({
      type: "article",
      id: UUID,
      langcode: "de",
      attributes: { title: "Hallo", body: { value: "B", format: "full_html" } },
    });

    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg).toMatchObject({ entityType: "node", bundle: "article", id: UUID });
    expect(arg.attributes.langcode).toBe("de");
    expect(arg.attributes.title).toBe("Hallo");
    expect(out.langcode).toBe("de");
  });

  it("create_translation defaults to node and requires a langcode", async () => {
    backend.updateEntity.mockResolvedValue({ id: UUID, langcode: "fr" });
    await handlers.drupal_create_translation({ type: "article", id: UUID, langcode: "fr", attributes: {} });
    const arg = backend.updateEntity.mock.calls[0][0];
    expect(arg.entityType).toBe("node");
    expect(arg.attributes.langcode).toBe("fr");
  });

  it("create_translation rejects a missing/blank langcode", async () => {
    await expect(
      handlers.drupal_create_translation({ type: "article", id: UUID, langcode: "", attributes: {} })
    ).rejects.toThrow();
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("create_translation validates the langcode shape (no path injection)", async () => {
    await expect(
      handlers.drupal_create_translation({ type: "article", id: UUID, langcode: "../../evil", attributes: {} })
    ).rejects.toThrow();
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("create_translation validates the id (rejects non-UUID)", async () => {
    await expect(
      handlers.drupal_create_translation({ type: "article", id: "nope", langcode: "de", attributes: {} })
    ).rejects.toThrow();
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });
});
