import { describe, it, expect, vi } from "vitest";
import {
  PatchBlockedError,
  WorkingCopyStaleError,
  PATCH_BLOCKED_CODE,
  PATCH_BLOCKED_MESSAGE,
  PATCH_WORKING_COPY_STALE_MESSAGE,
  isWorkingCopyPatchError,
  rewriteWorkingCopyPatchError,
  shouldPreflightPatch,
  preflightPatchWritable,
  prepareGuardedPatch,
  resolveWorkingCopyPatchTarget,
  updateEntityGuarded,
  isProbePassedWithoutSave,
  PATCH_PROBE_MISMATCH_ID,
} from "../../src/lib/patch-preflight.js";
import {
  attachRevisionPair,
  attachWrittenRevisionPair,
  readWrittenRevision,
} from "../../src/lib/write-revision.js";

const WC_400 = new Error(
  "Drupal 400 on PATCH /jsonapi/node/solution/n1: Updating a resource object " +
  "that has a working copy is not yet supported. See " +
  "https://www.drupal.org/project/drupal/issues/2795279."
);

const ID_MISMATCH = new Error(
  "Drupal 400 on PATCH /jsonapi/node/article/n1: The selected entity (n1) " +
  `does not match the ID in the payload (${PATCH_PROBE_MISMATCH_ID}).`
);

function backendStub(over = {}) {
  return {
    resourcePath: (et, b) => `/jsonapi/${et}/${b}`,
    rawQuery: vi.fn(async () => { throw ID_MISMATCH; }),
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
  it("PATCHes a mismatched id so the guard runs and save does not", async () => {
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
      data: { type: "node--article", id: PATCH_PROBE_MISMATCH_ID },
    });
    expect(JSON.parse(arg.options.body).data).not.toHaveProperty("attributes");
    expect(JSON.parse(arg.options.body).data).not.toHaveProperty("relationships");
  });

  it("treats a 2xx probe as a failure — that would have saved a revision", async () => {
    const backend = backendStub({
      rawQuery: vi.fn(async () => ({ data: { type: "node--article", id: "n1" } })),
    });
    await expect(preflightPatchWritable({
      backend, entityType: "node", bundle: "article", id: "n1",
      existing: { fields: { moderation_state: "published" } },
      attributes: { moderation_state: "draft" },
    })).rejects.toThrow(/unexpectedly succeeded/);
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

  it("does not prescribe publish-or-discard when a working copy is addressable (#166)", async () => {
    const backend = backendStub({
      rawQuery: vi.fn(async () => { throw WC_400; }),
      getEntity: vi.fn(async ({ resourceVersion }) => {
        if (resourceVersion === "rel:working-copy") {
          return { id: "n1", fields: { drupal_internal__vid: 2070 } };
        }
        return null;
      }),
    });
    let caught;
    try {
      await preflightPatchWritable({
        backend, entityType: "node", bundle: "solution", id: "n1",
        existing: { fields: { moderation_state: "published" } },
        attributes: { moderation_state: "draft" },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkingCopyStaleError);
    expect(caught.message).toBe(PATCH_WORKING_COPY_STALE_MESSAGE);
    expect(caught.message).not.toMatch(/Publish or discard/i);
    expect(caught.message).not.toMatch(/revision surgery/i);
  });

  it("keeps the surgery message when the working copy does not resolve (#201)", async () => {
    const backend = backendStub({
      rawQuery: vi.fn(async () => { throw WC_400; }),
      getEntity: vi.fn(async () => {
        throw new Error("Drupal 403: No pending revision for moderated entity.");
      }),
    });
    await expect(preflightPatchWritable({
      backend, entityType: "node", bundle: "solution", id: "n1",
      existing: { fields: { moderation_state: "published" } },
      attributes: { moderation_state: "draft" },
    })).rejects.toMatchObject({
      name: "PatchBlockedError",
      message: PATCH_BLOCKED_MESSAGE,
    });
  });

  it("treats an id-mismatch 400 as the guard having passed with no save", async () => {
    expect(isProbePassedWithoutSave(ID_MISMATCH)).toBe(true);
    const backend = backendStub();
    const out = await preflightPatchWritable({
      backend, entityType: "node", bundle: "article", id: "n1",
      attributes: { moderation_state: "draft" },
    });
    expect(out).toEqual({ probed: true, writable: true });
  });

  it("treats a deserialize 422 as the guard having passed with no save", async () => {
    const backend = backendStub({
      rawQuery: vi.fn(async () => { throw new Error("Drupal 422 on PATCH /jsonapi/node/article/n1: no fields"); }),
    });
    const out = await preflightPatchWritable({
      backend, entityType: "node", bundle: "article", id: "n1",
      attributes: { moderation_state: "draft" },
    });
    expect(out).toEqual({ probed: true, writable: true });
  });

  it("probes the working-copy URL when resourceVersion is set (#166)", async () => {
    const backend = backendStub();
    const out = await preflightPatchWritable({
      backend, entityType: "node", bundle: "article", id: "n1",
      existing: { fields: { moderation_state: "published" } },
      attributes: { title: "T", moderation_state: "draft" },
      resourceVersion: "rel:working-copy",
    });
    expect(out).toEqual({ probed: true, writable: true });
    expect(backend.rawQuery.mock.calls[0][0].path).toBe(
      "/jsonapi/node/article/n1?resourceVersion=rel%3Aworking-copy",
    );
  });

  it("treats a working-copy 400 on the working-copy probe as stale (#166)", async () => {
    const backend = backendStub({ rawQuery: vi.fn(async () => { throw WC_400; }) });
    await expect(preflightPatchWritable({
      backend, entityType: "node", bundle: "solution", id: "n1",
      existing: { fields: { moderation_state: "published" } },
      attributes: { moderation_state: "draft" },
      resourceVersion: "rel:working-copy",
    })).rejects.toThrow(/stale or concurrent|#166/i);
  });
});

describe("updateEntityGuarded (#201)", () => {
  it("rewrites a working-copy 400 from the real write", async () => {
    const backend = backendStub({ updateEntity: vi.fn(async () => { throw WC_400; }) });
    await expect(updateEntityGuarded(backend, { entityType: "node", bundle: "a", id: "n1" }))
      .rejects.toBeInstanceOf(PatchBlockedError);
  });

  it("treats a blocked write as stale when the working copy is addressable (#166)", async () => {
    const backend = backendStub({
      updateEntity: vi.fn(async () => { throw WC_400; }),
      getEntity: vi.fn(async ({ resourceVersion }) => (
        resourceVersion === "rel:working-copy"
          ? { id: "n1", fields: { drupal_internal__vid: 42 } }
          : null
      )),
    });
    await expect(updateEntityGuarded(backend, { entityType: "node", bundle: "a", id: "n1" }))
      .rejects.toMatchObject({
        name: "WorkingCopyStaleError",
        message: PATCH_WORKING_COPY_STALE_MESSAGE,
      });
  });

  it("treats a working-copy-targeted write 400 as stale and does not retry canonical (#166)", async () => {
    const backend = backendStub({
      updateEntity: vi.fn(async () => { throw WC_400; }),
    });
    await expect(updateEntityGuarded(backend, {
      entityType: "node", bundle: "a", id: "n1", resourceVersion: "rel:working-copy",
    })).rejects.toBeInstanceOf(WorkingCopyStaleError);
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
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

  it("re-reads rel:working-copy after a draft-targeted write, not the live body", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => (
        resourceVersion === "rel:working-copy"
          ? { id: "n1", title: "Draft title", url: "/draft" }
          : { id: "n1", title: "Live title", url: "/live" }
      )),
    });
    const out = await readWrittenRevision({
      backend, entityType: "node", bundle: "article", id: "n1",
      relationshipsSent: false,
      patchResult: { id: "n1", title: "Draft title", url: null },
      preferCanonical: true,
      resourceVersion: "rel:working-copy",
    });
    expect(out.title).toBe("Draft title");
    expect(out.url).toBe("/draft");
    expect(backend.getEntity).toHaveBeenCalledWith({
      entityType: "node", bundle: "article", id: "n1",
      resourceVersion: "rel:working-copy",
    });
  });
});

describe("attachRevisionPair (#166)", () => {
  it("attaches only when live and working vids are both present and distinct", () => {
    expect(attachRevisionPair({ id: "n1" }, { live: 10, working: 11 }))
      .toEqual({ id: "n1", _revisions: { live: 10, working: 11 } });
    const entity = { id: "n1" };
    expect(attachRevisionPair(entity, { live: 10, working: 10 })).toBe(entity);
    expect(attachRevisionPair(entity, { live: 10, working: null })).toBe(entity);
  });
});

describe("attachWrittenRevisionPair (#166)", () => {
  it("does not invent a working vid from the write body when the alias cannot be read", async () => {
    const entity = { id: "n1", fields: { drupal_internal__vid: 10 } };
    const backend = backendStub({
      getEntity: vi.fn(async () => { throw new Error("no working copy"); }),
    });
    const out = await attachWrittenRevisionPair({
      backend, entityType: "node", bundle: "a", id: "n1", entity, liveVid: 10,
    });
    expect(out._revisions).toBeUndefined();
  });
});

describe("prepareGuardedPatch (#166)", () => {
  it("does not report a live vid when the PATCH probe is skipped", async () => {
    const backend = backendStub();
    const out = await prepareGuardedPatch(backend, {
      entityType: "node", bundle: "page", id: "n1",
      existing: { fields: { body: "x", drupal_internal__vid: 4 } },
      attributes: { title: "T" },
    });
    expect(out.liveVid).toBeNull();
    expect(out.workingVid).toBeNull();
    expect(out.resourceVersion).toBeUndefined();
  });
});

describe("resolveWorkingCopyPatchTarget (#166)", () => {
  it("fetches the canonical entity when existing has no readable vid", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => {
        if (resourceVersion === "rel:working-copy") {
          return { id: "n1", fields: { drupal_internal__vid: 20 } };
        }
        return { id: "n1", fields: { drupal_internal__vid: 10 } };
      }),
    });
    const out = await resolveWorkingCopyPatchTarget(backend, {
      entityType: "node", bundle: "article", id: "n1",
      existing: { id: "n1", title: "T" },
    });
    expect(out.liveVid).toBe(10);
    expect(out.workingVid).toBe(20);
    expect(out.resourceVersion).toBe("rel:working-copy");
    expect(backend.getEntity).toHaveBeenCalledWith({
      entityType: "node", bundle: "article", id: "n1",
    });
  });
});
