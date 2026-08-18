import { describe, it, expect, vi } from "vitest";
import {
  ErrRelationshipError,
  isParagraphResourceType,
  parseResourceType,
  paragraphRevisionId,
  embedParagraphRef,
  linkageHasRevisionMeta,
  relationshipsWereSent,
  resolveErrRelationships,
  resolveParagraphRevisionId,
  missingParagraphRevisionError,
} from "../../src/lib/err-relationships.js";

function paragraphEntity(id, revisionId, bundle = "capability") {
  return {
    id,
    entityType: "paragraph",
    bundle,
    fields: { drupal_internal__revision_id: revisionId },
    relationships: {},
  };
}

describe("paragraph identifier helpers (#192)", () => {
  it("detects paragraph resource types and leaves others alone", () => {
    expect(isParagraphResourceType("paragraph--capability")).toBe(true);
    expect(isParagraphResourceType("taxonomy_term--tags")).toBe(false);
    expect(isParagraphResourceType("media--image")).toBe(false);
    expect(isParagraphResourceType(null)).toBe(false);
  });

  it("parseResourceType splits entityType--bundle, including extra dashes", () => {
    expect(parseResourceType("paragraph--key-capability")).toEqual({
      entityType: "paragraph", bundle: "key-capability",
    });
    expect(parseResourceType("node")).toBeNull();
  });

  it("paragraphRevisionId reads fields then a top-level fallback", () => {
    expect(paragraphRevisionId(paragraphEntity("p1", 17))).toBe(17);
    expect(paragraphRevisionId({ drupal_internal__revision_id: "22" })).toBe(22);
    expect(paragraphRevisionId({ fields: {} })).toBeNull();
    expect(paragraphRevisionId(null)).toBeNull();
  });

  it("embedParagraphRef includes meta.target_revision_id when a vid is known", () => {
    expect(embedParagraphRef("text", "p-uuid-1", 42)).toEqual({
      type: "paragraph--text",
      id: "p-uuid-1",
      meta: { target_revision_id: 42 },
    });
    expect(embedParagraphRef("text", "p-uuid-1", null)).toEqual({
      type: "paragraph--text",
      id: "p-uuid-1",
    });
  });

  it("linkageHasRevisionMeta requires a non-empty target_revision_id", () => {
    expect(linkageHasRevisionMeta({ meta: { target_revision_id: 9 } })).toBe(true);
    expect(linkageHasRevisionMeta({ meta: {} })).toBe(false);
    expect(linkageHasRevisionMeta({ type: "paragraph--text", id: "p" })).toBe(false);
  });

  it("relationshipsWereSent is true for any non-empty map, including a clear", () => {
    expect(relationshipsWereSent({})).toBe(false);
    expect(relationshipsWereSent(null)).toBe(false);
    expect(relationshipsWereSent({ field_x: { data: [] } })).toBe(true);
  });
});

describe("resolveErrRelationships (#192)", () => {
  it("injects meta.target_revision_id from a stub GET for paragraph linkage", async () => {
    const getEntity = vi.fn(async ({ id }) => paragraphEntity(id, 88));
    const resolved = await resolveErrRelationships(
      { getEntity },
      {
        field_key_capabilities: {
          data: [
            { type: "paragraph--capability", id: "p-1" },
            { type: "paragraph--capability", id: "p-2" },
          ],
        },
      }
    );
    expect(getEntity).toHaveBeenCalledTimes(2);
    expect(resolved.field_key_capabilities.data).toEqual([
      { type: "paragraph--capability", id: "p-1", meta: { target_revision_id: 88 } },
      { type: "paragraph--capability", id: "p-2", meta: { target_revision_id: 88 } },
    ]);
  });

  it("prefers a create-response vid in the revision cache over a follow-up GET", async () => {
    const getEntity = vi.fn();
    const cache = new Map([["p-fresh", 101]]);
    const resolved = await resolveErrRelationships(
      { getEntity },
      { field_cards: { data: [{ type: "paragraph--capability", id: "p-fresh" }] } },
      { revisionCache: cache }
    );
    expect(getEntity).not.toHaveBeenCalled();
    expect(resolved.field_cards.data[0].meta.target_revision_id).toBe(101);
  });

  it("keeps an already-present meta.target_revision_id and does not GET", async () => {
    const getEntity = vi.fn();
    const resolved = await resolveErrRelationships(
      { getEntity },
      {
        field_cards: {
          data: [{ type: "paragraph--capability", id: "p-1", meta: { target_revision_id: 7 } }],
        },
      }
    );
    expect(getEntity).not.toHaveBeenCalled();
    expect(resolved.field_cards.data[0].meta.target_revision_id).toBe(7);
  });

  it("leaves ordinary entity-reference identifiers unchanged", async () => {
    const getEntity = vi.fn();
    const rel = {
      field_tags: { data: [{ type: "taxonomy_term--tags", id: "t-1" }] },
      field_image: { data: { type: "media--image", id: "m-1" } },
    };
    const resolved = await resolveErrRelationships({ getEntity }, rel);
    expect(getEntity).not.toHaveBeenCalled();
    expect(resolved).toEqual(rel);
  });

  it("passes an empty array through as an explicit clear (does not fail)", async () => {
    const getEntity = vi.fn();
    const resolved = await resolveErrRelationships(
      { getEntity },
      { field_key_capabilities: { data: [] } }
    );
    expect(getEntity).not.toHaveBeenCalled();
    expect(resolved.field_key_capabilities.data).toEqual([]);
  });

  it("fails the whole write on GET 404 and does not return a partial list", async () => {
    const getEntity = vi.fn(async ({ id }) => (id === "p-ok" ? paragraphEntity(id, 3) : null));
    await expect(resolveErrRelationships(
      { getEntity },
      {
        field_key_capabilities: {
          data: [
            { type: "paragraph--capability", id: "p-ok" },
            { type: "paragraph--capability", id: "p-missing" },
          ],
        },
      }
    )).rejects.toBeInstanceOf(ErrRelationshipError);
    await expect(resolveErrRelationships(
      { getEntity },
      {
        field_key_capabilities: {
          data: [
            { type: "paragraph--capability", id: "p-ok" },
            { type: "paragraph--capability", id: "p-missing" },
          ],
        },
      }
    )).rejects.toThrow(/p-missing/);
  });

  it("resolveParagraphRevisionId prefers the create result then GETs", async () => {
    expect(await resolveParagraphRevisionId({}, paragraphEntity("p1", 17), "capability")).toBe(17);
    const getEntity = vi.fn(async () => paragraphEntity("p1", 9));
    expect(await resolveParagraphRevisionId(
      { getEntity },
      { id: "p1", entityType: "paragraph", bundle: "capability", fields: {} },
      "capability"
    )).toBe(9);
    expect(getEntity).toHaveBeenCalledTimes(1);
    expect(missingParagraphRevisionError("p1").message).toMatch(/^Created paragraph p1/);
    expect(missingParagraphRevisionError("p1", "Updated").message).toMatch(/^Updated paragraph p1/);
  });

  it("fails when the paragraph GET succeeds but exposes no revision id", async () => {
    const getEntity = vi.fn(async () => ({ id: "p-1", entityType: "paragraph", bundle: "text", fields: {} }));
    await expect(resolveErrRelationships(
      { getEntity },
      { field_cards: { data: [{ type: "paragraph--text", id: "p-1" }] } }
    )).rejects.toThrow(/drupal_internal__revision_id/);
  });
});
