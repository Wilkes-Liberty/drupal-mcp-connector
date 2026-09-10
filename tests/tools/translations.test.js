import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  getEntity: vi.fn(),
  updateEntity: vi.fn(),
  rawQuery: vi.fn(),
  resourcePath: vi.fn((entityType, bundle) => `/jsonapi/${entityType}/${bundle}`),
  toCanonical: vi.fn((data) => ({
    id: data.id, entityType: "node", bundle: "article",
    langcode: data.attributes?.langcode, title: data.attributes?.title,
    status: data.attributes?.status ?? false,
    fields: { drupal_internal__vid: data.attributes?.drupal_internal__vid },
  })),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: { preset: "development" } })),
}));

import { handlers, definitions } from "../../src/tools/translations.js";

const UUID = "11111111-2222-3333-4444-555555555555";

function inventoryMeta() {
  return {
    meta: {
      defaultLangcode: "en",
      live: {
        vid: "10",
        translations: [{ langcode: "en", default: true, status: true, title: "Hello", moderation_state: "published" }],
      },
      working: {
        vid: "11",
        translations: [
          { langcode: "en", default: true, status: true, title: "Hello", moderation_state: "published" },
          { langcode: "es", default: false, status: false, title: "Hola", moderation_state: "draft" },
        ],
      },
    },
  };
}

beforeEach(() => {
  backend.getEntity.mockReset();
  backend.updateEntity.mockReset();
  backend.rawQuery.mockReset();
  backend.toCanonical.mockClear();
});

describe("translations tools", () => {
  it("exposes the two governed tools with correct required params", () => {
    const names = definitions.map((d) => d.name).sort();
    expect(names).toEqual(["drupal_create_translation", "drupal_list_translations"]);

    const list = definitions.find((d) => d.name === "drupal_list_translations");
    expect(list.inputSchema.required).toEqual(expect.arrayContaining(["type", "id"]));

    const create = definitions.find((d) => d.name === "drupal_create_translation");
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(["type", "id", "langcode"]));
    expect(create.description).toMatch(/unpublished non-default draft/);
    expect(create.description).not.toMatch(/replace a translation/);
  });

  it("list_translations prefers Sentinel inventory over a single JSON:API langcode", async () => {
    backend.rawQuery.mockResolvedValue(inventoryMeta());
    const out = await handlers.drupal_list_translations({ type: "article", id: UUID });
    expect(backend.rawQuery.mock.calls[0][0].path).toBe(`/jsonapi/node/article/${UUID}/mcp-translations`);
    expect(out.langcodes).toEqual(["en", "es"]);
    expect(out.working.vid).toBe("11");
    expect(out.live.translations).toHaveLength(1);
  });

  it("list_translations falls back to one observable langcode when Sentinel is absent", async () => {
    backend.rawQuery
      .mockRejectedValueOnce(new Error("Drupal 404 on GET /jsonapi/node/article/x/mcp-translations"))
      .mockResolvedValueOnce({
        data: { type: "node--article", id: UUID, attributes: { title: "Hello", langcode: "en" } },
      });
    const out = await handlers.drupal_list_translations({ type: "article", id: UUID });
    expect(out.langcodes).toEqual(["en"]);
    expect(out.note).toMatch(/unavailable/);
  });

  it("create_translation POSTs the translation endpoint instead of PATCHing langcode", async () => {
    const live = {
      id: UUID, entityType: "node", bundle: "article", langcode: "en", status: true,
      fields: { drupal_internal__vid: 10, moderation_state: "published" },
    };
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => (
      resourceVersion === "rel:working-copy" ? null : live
    ));
    backend.rawQuery.mockResolvedValue({
      data: {
        type: "node--article", id: UUID,
        attributes: { title: "Hallo", langcode: "de", status: false, drupal_internal__vid: 12 },
      },
    });
    const out = await handlers.drupal_create_translation({
      type: "article",
      id: UUID,
      langcode: "de",
      attributes: { title: "Hallo" },
    });
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(backend.rawQuery).toHaveBeenCalledOnce();
    const call = backend.rawQuery.mock.calls[0][0];
    expect(call.path).toBe(`/jsonapi/node/article/${UUID}/mcp-draft/translations`);
    expect(call.options.method).toBe("POST");
    expect(call.options.headers["X-MCP-Draft-Langcode"]).toBe("de");
    expect(call.options.headers["If-Match"]).toBe('"10"');
    const body = JSON.parse(call.options.body);
    expect(body.data.attributes.langcode).toBeUndefined();
    expect(body.data.attributes.title).toBe("Hallo");
    expect(out.langcode).toBe("de");
  });

  it("create_translation uses live:working If-Match when an English working copy exists", async () => {
    backend.getEntity.mockImplementation(async ({ resourceVersion }) => (
      resourceVersion === "rel:working-copy"
        ? { id: UUID, fields: { drupal_internal__vid: 11 } }
        : { id: UUID, status: true, fields: { drupal_internal__vid: 10, moderation_state: "published" } }
    ));
    backend.rawQuery.mockResolvedValue({
      data: { type: "node--article", id: UUID, attributes: { title: "Hallo", langcode: "de" } },
    });
    await handlers.drupal_create_translation({ type: "article", id: UUID, langcode: "de", attributes: { title: "Hallo" } });
    expect(backend.rawQuery.mock.calls[0][0].options.headers["If-Match"]).toBe('"10:11"');
  });

  it("create_translation rejects a missing/blank langcode", async () => {
    await expect(
      handlers.drupal_create_translation({ type: "article", id: UUID, langcode: "", attributes: {} })
    ).rejects.toThrow();
    expect(backend.rawQuery).not.toHaveBeenCalled();
  });

  it("create_translation validates the langcode shape (no path injection)", async () => {
    await expect(
      handlers.drupal_create_translation({ type: "article", id: UUID, langcode: "../../evil", attributes: {} })
    ).rejects.toThrow();
  });

  it("create_translation validates the id (rejects non-UUID)", async () => {
    await expect(
      handlers.drupal_create_translation({ type: "article", id: "nope", langcode: "de", attributes: {} })
    ).rejects.toThrow();
  });

  it("create_translation for a paragraph POSTs the paragraph translation endpoint", async () => {
    backend.getEntity.mockResolvedValue({
      id: UUID, entityType: "paragraph", bundle: "text_block",
      fields: { drupal_internal__revision_id: 3556 },
    });
    backend.rawQuery.mockResolvedValue({
      data: { type: "paragraph--text_block", id: UUID, attributes: { field_text: "Hola hero", langcode: "es" } },
    });
    await handlers.drupal_create_translation({
      entityType: "paragraph", type: "text_block", id: UUID, langcode: "es",
      revisionId: "3556", attributes: { field_text: "Hola hero" },
    });
    expect(backend.updateEntity).not.toHaveBeenCalled();
    const call = backend.rawQuery.mock.calls[0][0];
    expect(call.path).toBe(`/jsonapi/paragraph/text_block/${UUID}/mcp-draft/translations`);
    expect(call.options.method).toBe("POST");
    expect(call.options.headers["If-Match"]).toBe('"3556"');
    expect(call.options.headers["X-MCP-Draft-Langcode"]).toBe("es");
  });

  it("create_translation forwards image relationships for alt-only writes", async () => {
    backend.getEntity.mockResolvedValue({
      id: UUID, entityType: "node", bundle: "person", status: true,
      fields: { drupal_internal__vid: 10, moderation_state: "published" },
    });
    backend.rawQuery.mockResolvedValue({
      data: { type: "node--person", id: UUID, attributes: { title: "Nombre", langcode: "es" } },
    });
    const fileId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await handlers.drupal_create_translation({
      type: "person", id: UUID, langcode: "es",
      attributes: { title: "Nombre" },
      relationships: {
        field_photo: { data: { type: "file--file", id: fileId, meta: { alt: "Translated alt" } } },
      },
    });
    const body = JSON.parse(backend.rawQuery.mock.calls[0][0].options.body);
    expect(body.data.relationships.field_photo.data.meta.alt).toBe("Translated alt");
    expect(body.data.relationships.field_photo.data.id).toBe(fileId);
  });

  it("create_translation rejects entity types other than node and paragraph", async () => {
    await expect(
      handlers.drupal_create_translation({ entityType: "media", type: "image", id: UUID, langcode: "es" })
    ).rejects.toThrow(/nodes and paragraphs/);
    expect(backend.rawQuery).not.toHaveBeenCalled();
  });
});
