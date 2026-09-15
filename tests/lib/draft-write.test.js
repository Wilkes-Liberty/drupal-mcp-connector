import { describe, it, expect, vi } from "vitest";
import {
  isMissingDraftEndpoint,
  isMissingTranslationEndpoint,
  resolveNodeTranslationPair,
  supportsSentinelDraft,
  writeDraft,
} from "../../src/lib/draft-write.js";

const input = {
  entityType: "node", bundle: "page", id: "example-uuid",
  attributes: { title: "Next draft", moderation_state: "draft" },
  relationships: { field_cards: { data: [] } },
  draftRevision: { liveVid: 10, workingVid: 11 },
};
const backend = (result) => ({
  rawQuery: vi.fn().mockResolvedValue(result),
  resourcePath: () => "/jsonapi/node/page",
  toCanonical: vi.fn(x => x),
});

describe("governed draft continuation", () => {
  it("preflights the real payload with both revision IDs and no revision query", async () => {
    const b = backend({ meta: { draft_preflight: true, live: "10", working: "11" } });
    await writeDraft(b, input, true);
    const [{ path, options }] = b.rawQuery.mock.calls[0];
    expect(path).toBe("/jsonapi/node/page/example-uuid/mcp-draft");
    expect(options.headers).toEqual({ "If-Match": '"10:11"', "X-MCP-Draft-Preflight": "1" });
    expect(JSON.parse(options.body).data).toMatchObject({ attributes: input.attributes, relationships: input.relationships });
  });
  it("writes through the same endpoint with preflight disabled", async () => {
    const b = backend({ data: { id: input.id, type: "node--page" } });
    await writeDraft(b, input);
    expect(b.rawQuery.mock.calls[0][0].options.headers["X-MCP-Draft-Preflight"]).toBe("0");
    expect(b.toCanonical).toHaveBeenCalledOnce();
  });
  it("fails closed on an absent endpoint, without fallback", async () => {
    const b = backend();
    b.rawQuery.mockRejectedValue(new Error("Drupal 404 on PATCH"));
    await expect(writeDraft(b, input, true)).rejects.toThrow("Update the server-side module");
    expect(b.rawQuery).toHaveBeenCalledOnce();
  });
  it("refuses a generic success that does not prove non-saving preflight", async () => {
    await expect(writeDraft(backend({}), input, true)).rejects.toThrow("non-saving");
  });
  it("refuses missing or identical revision preconditions before HTTP", async () => {
    const b = backend();
    await expect(writeDraft(b, { ...input, draftRevision: { liveVid: 10, workingVid: 10 } })).rejects.toThrow("distinct");
    expect(b.rawQuery).not.toHaveBeenCalled();
  });
  it("does not retry a stale revision", async () => {
    const b = backend();
    b.rawQuery.mockRejectedValue(new Error("Drupal 409 conflict"));
    await expect(writeDraft(b, input)).rejects.toThrow("409");
    expect(b.rawQuery).toHaveBeenCalledOnce();
  });
  it("sends X-MCP-Draft-Langcode when continuing a translation", async () => {
    const b = backend({ meta: { draft_preflight: true, live: "10", working: "11", langcode: "es" } });
    await writeDraft(b, { ...input, langcode: "es" }, true);
    expect(b.rawQuery.mock.calls[0][0].options.headers["X-MCP-Draft-Langcode"]).toBe("es");
  });

  it("PATCHes media drafts on /mcp-draft with the live:working pair (#296)", async () => {
    const b = backend({ data: { id: "media-uuid", type: "media--image" } });
    b.resourcePath = () => "/jsonapi/media/image";
    await writeDraft(b, {
      entityType: "media", bundle: "image", id: "media-uuid",
      attributes: { name: "Imagen aeroespacial" },
      langcode: "es",
      draftRevision: { liveVid: 40, workingVid: 41 },
    });
    const [{ path, options }] = b.rawQuery.mock.calls[0];
    expect(path).toBe("/jsonapi/media/image/media-uuid/mcp-draft");
    expect(options.method).toBe("PATCH");
    expect(options.headers["If-Match"]).toBe('"40:41"');
    expect(options.headers["X-MCP-Draft-Langcode"]).toBe("es");
  });
});

describe("governed translation create", () => {
  it("POSTs paragraph translations with the pinned revision If-Match", async () => {
    const { createTranslationDraft } = await import("../../src/lib/draft-write.js");
    const b = backend({ data: { id: "p-uuid", type: "paragraph--text_block" } });
    b.resourcePath = () => "/jsonapi/paragraph/text_block";
    await createTranslationDraft(b, {
      entityType: "paragraph", bundle: "text_block", id: "p-uuid",
      langcode: "es", attributes: { field_text: "Hola hero" },
      draftRevision: { revisionId: 3556 },
    });
    const [{ path, options }] = b.rawQuery.mock.calls[0];
    expect(path).toBe("/jsonapi/paragraph/text_block/p-uuid/mcp-draft/translations");
    expect(options.headers["If-Match"]).toBe('"3556"');
    expect(options.headers["X-MCP-Draft-Langcode"]).toBe("es");
  });

  it("rewrites Sentinel's live-only working-revision 409 (#282)", async () => {
    const { createTranslationDraft, rewriteTranslationWorkingRevisionError } = await import("../../src/lib/draft-write.js");
    const b = backend();
    b.rawQuery.mockRejectedValue(new Error(
      "Drupal 409 on POST /jsonapi/node/page/x/mcp-draft/translations: A working revision exists. Reload and send both revision IDs.",
    ));
    await expect(createTranslationDraft(b, {
      ...input, langcode: "es", attributes: { title: "Artículos" },
      draftRevision: { liveVid: 1479 },
    })).rejects.toThrow(/working draft exists|#282/);
    const wrapped = rewriteTranslationWorkingRevisionError(new Error("A working revision exists. Reload and send both revision IDs."));
    expect(wrapped.message).toMatch(/#282/);
  });

  it("POSTs translations with live-only If-Match when there is no working copy", async () => {
    const { createTranslationDraft } = await import("../../src/lib/draft-write.js");
    const b = backend({ data: { id: input.id, type: "node--page", attributes: { title: "Artículos", langcode: "es" } } });
    await createTranslationDraft(b, {
      ...input, langcode: "es", attributes: { title: "Artículos", langcode: "es" },
      draftRevision: { liveVid: 10 },
    });
    const [{ path, options }] = b.rawQuery.mock.calls[0];
    expect(path).toBe("/jsonapi/node/page/example-uuid/mcp-draft/translations");
    expect(options.method).toBe("POST");
    expect(options.headers["If-Match"]).toBe('"10"');
    expect(options.headers["X-MCP-Draft-Langcode"]).toBe("es");
    expect(JSON.parse(options.body).data.attributes.langcode).toBeUndefined();
  });

  it("POSTs media translations on the same live/working surface as nodes (#296)", async () => {
    const { createTranslationDraft } = await import("../../src/lib/draft-write.js");
    const b = backend({ data: { id: "media-uuid", type: "media--image" } });
    b.resourcePath = () => "/jsonapi/media/image";
    await createTranslationDraft(b, {
      entityType: "media", bundle: "image", id: "media-uuid",
      langcode: "es",
      attributes: { name: "Imagen aeroespacial", field_caption: "Demostración" },
      relationships: {
        field_media_image: { data: { type: "file--file", id: "file-uuid", meta: { alt: "Avión" } } },
      },
      draftRevision: { liveVid: 40 },
    });
    const [{ path, options }] = b.rawQuery.mock.calls[0];
    expect(path).toBe("/jsonapi/media/image/media-uuid/mcp-draft/translations");
    expect(options.method).toBe("POST");
    expect(options.headers["If-Match"]).toBe('"40"');
    expect(options.headers["X-MCP-Draft-Langcode"]).toBe("es");
    const body = JSON.parse(options.body);
    expect(body.data.attributes.langcode).toBeUndefined();
    expect(body.data.attributes.moderation_state).toBeUndefined();
    expect(body.data.relationships.field_media_image.data.meta.alt).toBe("Avión");
  });
});


describe("paragraph draft state", () => {
  const paragraph = {
    entityType: "paragraph", bundle: "text", id: "p1", langcode: "es",
    draftRevision: { revisionId: 17 }, attributes: { field_text: "Dos" },
    draftState: "a".repeat(64),
  };
  it("refuses absent state before any request", async () => {
    const b = backend();
    await expect(writeDraft(b, { ...paragraph, draftState: undefined })).rejects.toThrow("draftState");
    expect(b.rawQuery).not.toHaveBeenCalled();
  });
  it("passes the caller's original token and returns the next token", async () => {
    const b = backend({ data: { id: "p1", type: "paragraph--text" }, meta: { draft_state: "b".repeat(64) } });
    const out = await writeDraft(b, paragraph);
    expect(b.rawQuery.mock.calls[0][0].options.headers["X-MCP-Draft-State"]).toBe(paragraph.draftState);
    expect(out.draftState).toBe("b".repeat(64));
  });
  it("does not refresh and retry stale copy", async () => {
    const b = backend();
    b.rawQuery.mockRejectedValue(new Error("Drupal 409: paragraph draft changed"));
    await expect(writeDraft(b, paragraph)).rejects.toThrow("409");
    expect(b.rawQuery).toHaveBeenCalledOnce();
  });
});

describe("Sentinel capability and missing-endpoint classifiers", () => {
  it("treats JSON:API resourcePath + rawQuery as Sentinel-capable without a flag", () => {
    expect(supportsSentinelDraft({
      rawQuery: () => {},
      resourcePath: () => "/jsonapi/node/page",
    })).toBe(true);
  });

  it("does not treat GraphQL rawQuery as Sentinel-capable", async () => {
    const graphqlish = {
      rawQuery: vi.fn(async ({ query }) => ({ data: { query } })),
      capabilities: () => ({ read: true, write: false, sentinelDraft: false }),
    };
    expect(supportsSentinelDraft(graphqlish)).toBe(false);
    await expect(writeDraft(graphqlish, input, true)).rejects.toThrow(/does not support governed draft continuation/);
    expect(graphqlish.rawQuery).not.toHaveBeenCalled();
  });

  it("does not treat a query-shaped rawQuery without resourcePath as Sentinel-capable", async () => {
    const graphqlish = { rawQuery: vi.fn(async ({ query }) => ({ data: { query } })) };
    expect(supportsSentinelDraft(graphqlish)).toBe(false);
    await expect(writeDraft(graphqlish, input, true)).rejects.toThrow(/does not support governed draft continuation/);
    expect(graphqlish.rawQuery).not.toHaveBeenCalled();
  });

  it("classifies only the rewritten missing-endpoint English as absence", () => {
    expect(isMissingDraftEndpoint(new Error(
      "The site does not provide Sentinel's governed draft endpoint (d.o #3621022). Update the server-side module.",
    ))).toBe(true);
    expect(isMissingTranslationEndpoint(new Error(
      "The site does not provide Sentinel's governed draft-translation endpoint. Update MCP Sentinel.",
    ))).toBe(true);
    expect(isMissingTranslationEndpoint(new Error("Drupal 403 on GET /jsonapi/node/page/x/mcp-translations"))).toBe(false);
    expect(isMissingTranslationEndpoint(new Error("Drupal 500 on GET /jsonapi/node/page/x/mcp-translations"))).toBe(false);
    expect(isMissingDraftEndpoint(new Error("Drupal 409 conflict"))).toBe(false);
  });
});

describe("resolveNodeTranslationPair fail-closed inventory", () => {
  const existing = { fields: { drupal_internal__vid: 10 } };

  it("falls back to rel:working-copy when the translation endpoint is absent (404)", async () => {
    const b = backend();
    b.rawQuery.mockRejectedValue(new Error("Drupal 404 on GET /jsonapi/node/page/x/mcp-translations"));
    b.getEntity = vi.fn(async ({ resourceVersion }) => (
      resourceVersion === "rel:working-copy" ? { fields: { drupal_internal__vid: 11 } } : existing
    ));
    await expect(resolveNodeTranslationPair(b, {
      entityType: "node", bundle: "page", id: "example-uuid", existing,
    })).resolves.toEqual({ liveVid: 10, workingVid: 11 });
  });

  it("falls back to rel:working-copy when the translation endpoint is absent (405)", async () => {
    const b = backend();
    b.rawQuery.mockRejectedValue(new Error("Drupal 405 on GET /jsonapi/node/page/x/mcp-translations"));
    b.getEntity = vi.fn(async () => null);
    await expect(resolveNodeTranslationPair(b, {
      entityType: "node", bundle: "page", id: "example-uuid", existing,
    })).resolves.toEqual({ liveVid: 10, workingVid: undefined });
  });

  it("rethrows a permission failure instead of treating it as absence", async () => {
    const b = backend();
    b.rawQuery.mockRejectedValue(new Error("Drupal 403 on GET /jsonapi/node/page/x/mcp-translations"));
    b.getEntity = vi.fn();
    await expect(resolveNodeTranslationPair(b, {
      entityType: "node", bundle: "page", id: "example-uuid", existing,
    })).rejects.toThrow(/403/);
    expect(b.getEntity).not.toHaveBeenCalled();
  });

  it("rethrows a 5xx instead of treating it as absence", async () => {
    const b = backend();
    b.rawQuery.mockRejectedValue(new Error("Drupal 500 on GET /jsonapi/node/page/x/mcp-translations"));
    b.getEntity = vi.fn();
    await expect(resolveNodeTranslationPair(b, {
      entityType: "node", bundle: "page", id: "example-uuid", existing,
    })).rejects.toThrow(/500/);
    expect(b.getEntity).not.toHaveBeenCalled();
  });

  it("rethrows a malformed inventory instead of treating it as absence", async () => {
    const b = backend({ meta: {} });
    b.getEntity = vi.fn();
    await expect(resolveNodeTranslationPair(b, {
      entityType: "node", bundle: "page", id: "example-uuid", existing,
    })).rejects.toThrow(/did not return a translation inventory/);
    expect(b.getEntity).not.toHaveBeenCalled();
  });
});
