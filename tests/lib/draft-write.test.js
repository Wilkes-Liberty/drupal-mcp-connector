import { describe, it, expect, vi } from "vitest";
import { writeDraft } from "../../src/lib/draft-write.js";

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
});
