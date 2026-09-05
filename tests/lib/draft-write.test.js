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
});
