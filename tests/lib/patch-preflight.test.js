import { describe, it, expect, vi } from "vitest";
import {
  PatchBlockedError,
  PATCH_BLOCKED_CODE,
  PATCH_BLOCKED_MESSAGE,
  isWorkingCopyPatchError,
  rewriteWorkingCopyPatchError,
  shouldPreflightPatch,
  preflightPatchWritable,
  updateEntityGuarded,
} from "../../src/lib/patch-preflight.js";
import { readWrittenRevision } from "../../src/lib/write-revision.js";

const WC_400 = new Error(
  "Drupal 400 on PATCH /jsonapi/node/solution/n1: Updating a resource object " +
  "that has a working copy is not yet supported. See " +
  "https://www.drupal.org/project/drupal/issues/2795279."
);

function backendStub(over = {}) {
  return {
    resourcePath: (et, b) => `/jsonapi/${et}/${b}`,
    rawQuery: vi.fn(async () => ({ data: { type: "node--article", id: "n1" } })),
    getEntity: vi.fn(async () => null),
    updateEntity: vi.fn(async (input) => ({ id: input.id })),
    ...over,
  };
}

describe("working-copy PATCH error rewrite (#201)", () => {
  it("recognises core's working-copy 400 and rewrites it", () => {
    expect(isWorkingCopyPatchError(WC_400)).toBe(true);
    const rewritten = rewriteWorkingCopyPatchError(WC_400);
    expect(rewritten).toBeInstanceOf(PatchBlockedError);
    expect(rewritten.code).toBe(PATCH_BLOCKED_CODE);
    expect(rewritten.message).toBe(PATCH_BLOCKED_MESSAGE);
    expect(rewritten.message).toMatch(/#201/);
    expect(rewritten.message).toMatch(/2795279/);
    expect(rewritten.message).not.toMatch(/try again/i);
  });

  it("leaves unrelated errors alone", () => {
    const other = new Error("Drupal 422 on PATCH: title is required");
    expect(isWorkingCopyPatchError(other)).toBe(false);
    expect(rewriteWorkingCopyPatchError(other)).toBe(other);
  });
});

describe("shouldPreflightPatch (#201)", () => {
  it("probes when the caller pinned moderation_state or the entity looks moderated", () => {
    expect(shouldPreflightPatch({ attributes: { moderation_state: "draft" } })).toBe(true);
    expect(shouldPreflightPatch({
      existing: { fields: { moderation_state: "published" } },
      attributes: { title: "T" },
    })).toBe(true);
  });

  it("does not probe unmoderated / non-revisionable bundles", () => {
    expect(shouldPreflightPatch({
      existing: { fields: { body: "x" }, status: true },
      attributes: { title: "T" },
    })).toBe(false);
    expect(shouldPreflightPatch({ attributes: { title: "T" } })).toBe(false);
  });
});

describe("preflightPatchWritable (#201)", () => {
  it("issues a no-op PATCH with no relationships and no attribute mutation", async () => {
    const backend = backendStub();
    const out = await preflightPatchWritable({
      backend, entityType: "node", bundle: "article", id: "n1",
      existing: { fields: { moderation_state: "published" } },
      attributes: { title: "T", moderation_state: "draft" },
    });
    expect(out).toEqual({ probed: true, writable: true });
    expect(backend.rawQuery).toHaveBeenCalledTimes(1);
    const arg = backend.rawQuery.mock.calls[0][0];
    expect(arg.path).toBe("/jsonapi/node/article/n1");
    expect(arg.options.method).toBe("PATCH");
    expect(JSON.parse(arg.options.body)).toEqual({
      data: { type: "node--article", id: "n1" },
    });
  });

  it("skips the probe on unmoderated targets", async () => {
    const backend = backendStub();
    const out = await preflightPatchWritable({
      backend, entityType: "node", bundle: "page", id: "n1",
      existing: { fields: { body: "x" } },
      attributes: { title: "T" },
    });
    expect(out.probed).toBe(false);
    expect(backend.rawQuery).not.toHaveBeenCalled();
  });

  it("throws PatchBlockedError on the core 400 and does not treat it as writable", async () => {
    const backend = backendStub({ rawQuery: vi.fn(async () => { throw WC_400; }) });
    await expect(preflightPatchWritable({
      backend, entityType: "node", bundle: "solution", id: "n1",
      existing: { fields: { moderation_state: "published" } },
      attributes: { moderation_state: "draft" },
    })).rejects.toBeInstanceOf(PatchBlockedError);
  });

  it("treats an empty-body 422 as inconclusive rather than blocked", async () => {
    const backend = backendStub({
      rawQuery: vi.fn(async () => { throw new Error("Drupal 422 on PATCH /jsonapi/node/article/n1: no fields"); }),
    });
    const out = await preflightPatchWritable({
      backend, entityType: "node", bundle: "article", id: "n1",
      attributes: { moderation_state: "draft" },
    });
    expect(out).toEqual({ probed: true, writable: "unknown" });
  });
});

describe("updateEntityGuarded (#201)", () => {
  it("rewrites a working-copy 400 from the real write", async () => {
    const backend = backendStub({ updateEntity: vi.fn(async () => { throw WC_400; }) });
    await expect(updateEntityGuarded(backend, { entityType: "node", bundle: "a", id: "n1" }))
      .rejects.toBeInstanceOf(PatchBlockedError);
  });
});

describe("readWrittenRevision (#169)", () => {
  it("returns the working-copy body when relationships were sent", async () => {
    const wc = {
      id: "n1",
      relationships: { field_cards: [{ id: "p1", entityType: "paragraph", bundle: "c", meta: { target_revision_id: 1 } }] },
    };
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => (resourceVersion === "rel:working-copy" ? wc : { id: "n1", relationships: { field_cards: [] } })),
    });
    const out = await readWrittenRevision({
      backend, entityType: "node", bundle: "article", id: "n1",
      relationshipsSent: true,
      patchResult: { id: "n1", relationships: { field_cards: [] } },
    });
    expect(out.relationships.field_cards).toHaveLength(1);
    expect(out._revision.source).toBe("working-copy");
    expect(out._revision.relationshipsUnverified).toBeUndefined();
  });

  it("does not treat the canonical / PATCH body as proof when working-copy is missing", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async () => { throw new Error("Drupal 403: No pending revision for moderated entity."); }),
    });
    const patchResult = {
      id: "n1",
      relationships: { field_cards: [{ id: "old-1", entityType: "paragraph", bundle: "c" }] },
    };
    const out = await readWrittenRevision({
      backend, entityType: "node", bundle: "article", id: "n1",
      relationshipsSent: true,
      patchResult,
    });
    expect(out._revision.relationshipsUnverified).toBe(true);
    expect(out._revision.source).toBe("patch");
  });

  it("re-reads the canonical resource when no relationships were sent", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async () => ({ id: "n1", url: "/kept" })),
    });
    const out = await readWrittenRevision({
      backend, entityType: "node", bundle: "article", id: "n1",
      relationshipsSent: false,
      patchResult: { id: "n1", url: null },
      preferCanonical: true,
    });
    expect(out.url).toBe("/kept");
    expect(out._revision).toBeUndefined();
  });
});
