import { describe, it, expect, vi } from "vitest";
import {
  PatchBlockedError,
  WorkingCopyStaleError,
  StaleCopyError,
  PATCH_BLOCKED_CODE,
  PATCH_BLOCKED_MESSAGE,
  PATCH_WORKING_COPY_STALE_MESSAGE,
  STALE_COPY_CODE,
  STALE_COPY_MESSAGE,
  isWorkingCopyPatchError,
  rewriteWorkingCopyPatchError,
  shouldPreflightPatch,
  preflightPatchWritable,
  prepareGuardedPatch,
  resolveWorkingCopyPatchTarget,
  updateEntityGuarded,
  isProbePassedWithoutSave,
  changedAheadOfRevision,
  rewriteStaleCopyError,
  PATCH_PROBE_MISMATCH_ID,
} from "../../src/lib/patch-preflight.js";
import {
  attachRevisionPair,
  attachWrittenRevisionPair,
  entityRevisionId,
  readWrittenRevision,
} from "../../src/lib/write-revision.js";
import {
  RevisionIdentityError,
  UnsupportedDraftContinuationError,
} from "../../src/lib/canonical-draft.js";

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
    rawQuery: vi.fn(async ({ path }) => {
      if (path.endsWith("/mcp-translations")) throw new Error("Drupal 404 inventory unavailable");
      throw ID_MISMATCH;
    }),
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
    expect(out).toEqual({ probed: true, revisionGuardPassed: true, payloadEvaluated: false });
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
    expect(out).toEqual({ probed: true, revisionGuardPassed: true, payloadEvaluated: false });
  });

  it("treats a deserialize 422 as the guard having passed with no save", async () => {
    const backend = backendStub({
      rawQuery: vi.fn(async () => { throw new Error("Drupal 422 on PATCH /jsonapi/node/article/n1: no fields"); }),
    });
    const out = await preflightPatchWritable({
      backend, entityType: "node", bundle: "article", id: "n1",
      attributes: { moderation_state: "draft" },
    });
    expect(out).toEqual({ probed: true, revisionGuardPassed: true, payloadEvaluated: false });
  });

  it("probes the working-copy URL when resourceVersion is set (#166)", async () => {
    const backend = backendStub();
    const out = await preflightPatchWritable({
      backend, entityType: "node", bundle: "article", id: "n1",
      existing: { fields: { moderation_state: "published" } },
      attributes: { title: "T", moderation_state: "draft" },
      resourceVersion: "rel:working-copy",
    });
    expect(out).toEqual({ probed: true, revisionGuardPassed: true, payloadEvaluated: false });
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

  it("refuses revision-selected core PATCH before attempting HTTP (#166)", async () => {
    const backend = backendStub({
      updateEntity: vi.fn(async () => { throw WC_400; }),
    });
    await expect(updateEntityGuarded(backend, {
      entityType: "node", bundle: "a", id: "n1", resourceVersion: "rel:working-copy",
    })).rejects.toThrow("does not support revision-selected PATCH");
    expect(backend.updateEntity).not.toHaveBeenCalled();
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

describe("stale default-revision fingerprint (#273)", () => {
  const staleExisting = {
    id: "n1",
    status: true,
    changed: "2026-09-07T16:00:00Z",
    fields: {
      moderation_state: "published",
      drupal_internal__vid: 1962,
      revision_timestamp: "2026-09-01T00:00:00Z",
    },
  };

  it("changedAheadOfRevision matches possiblyPatchBlocked", () => {
    expect(changedAheadOfRevision(staleExisting)).toBe(true);
    expect(changedAheadOfRevision({
      ...staleExisting,
      changed: "2026-09-01T00:00:00Z",
    })).toBe(false);
    expect(changedAheadOfRevision({ changed: "2026-09-07T16:00:00Z" })).toBe(false);
  });

  it("prepareGuardedPatch does not treat a default-revision timestamp gap as a local stale copy (#405)", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async () => staleExisting),
    });
    const out = await prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: staleExisting,
      attributes: { title: "Draft title", moderation_state: "draft" },
    });
    expect(out.resourceVersion).toBeUndefined();
    expect(out.preflight).toBe("core_patch_guard");
    expect(backend.updateEntity).not.toHaveBeenCalled();
    const probe = backend.rawQuery.mock.calls.map(([q]) => q).find((q) => q.options?.method === "PATCH");
    expect(probe).toBeTruthy();
  });

  it("prepareGuardedPatch still rewrites an actual Sentinel stale-copy refusal (#273)", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async () => staleExisting),
      rawQuery: vi.fn(async ({ path }) => {
        if (String(path).endsWith("/mcp-translations")) throw new Error("Drupal 404 inventory unavailable");
        throw new Error(
          "Drupal 500: Write denied by MCP Sentinel: the content changed after this copy was loaded."
        );
      }),
    });
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: staleExisting,
      attributes: { title: "Draft title", moderation_state: "draft" },
    })).rejects.toMatchObject({
      name: "StaleCopyError",
      code: STALE_COPY_CODE,
    });
  });

  it("does not apply the fingerprint when a distinct working copy exists", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => {
        if (resourceVersion === "rel:working-copy") {
          return { id: "n1", fields: { drupal_internal__vid: 1963, moderation_state: "draft" } };
        }
        return staleExisting;
      }),
      rawQuery: vi.fn(async () => ({
        meta: { draft_preflight: true, live: "1962", working: "1963" },
      })),
    });
    const out = await prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: staleExisting,
      attributes: { title: "Draft title", moderation_state: "draft" },
    });
    expect(out.resourceVersion).toBe("rel:working-copy");
    expect(out.draftRevision).toEqual({ liveVid: 1962, workingVid: 1963 });
  });

  it("updateEntityGuarded rewrites Sentinel's stale-version refusal", async () => {
    const backend = backendStub({
      updateEntity: vi.fn(async () => {
        throw new Error(
          "Drupal 500: Write denied by MCP Sentinel: the content changed after this copy was loaded. " +
          "Reload the latest version and reapply the change.",
        );
      }),
    });
    await expect(updateEntityGuarded(backend, { entityType: "node", bundle: "solution", id: "n1" }))
      .rejects.toMatchObject({
        name: "StaleCopyError",
        code: STALE_COPY_CODE,
        message: STALE_COPY_MESSAGE,
      });
  });

  it("rewriteStaleCopyError leaves unrelated errors alone", () => {
    const other = new Error("Drupal 422 on PATCH: title is required");
    expect(rewriteStaleCopyError(other)).toBe(other);
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
    // #336: no server-side check ran, and the target says so.
    expect(out.preflight).toBe("none");
  });

  it("reports the core guard probe, which carries no fields, as core_patch_guard (#336)", async () => {
    const backend = backendStub();
    const out = await prepareGuardedPatch(backend, {
      entityType: "node", bundle: "article", id: "n1",
      existing: { fields: { moderation_state: "draft", drupal_internal__vid: 4 } },
      attributes: { title: "T", field_restricted: "x" },
    });
    expect(out.preflight).toBe("core_patch_guard");
    const probe = backend.rawQuery.mock.calls.map(([q]) => q).find((q) => q.options?.method === "PATCH");
    expect(JSON.parse(probe.options.body).data).not.toHaveProperty("attributes");
  });

  it("reports none when the backend cannot issue the probe (#336)", async () => {
    const backend = backendStub();
    delete backend.rawQuery;
    const out = await prepareGuardedPatch(backend, {
      entityType: "node", bundle: "article", id: "n1",
      existing: { fields: { moderation_state: "draft", drupal_internal__vid: 4 } },
      attributes: { title: "T" },
    });
    expect(out.preflight).toBe("none");
  });

  it("resolves inventory and draft-preflights when langcode is set on unmoderated media", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async () => null),
      rawQuery: vi.fn(async ({ path, options }) => {
        if (String(path).endsWith("/mcp-translations")) {
          return {
            meta: {
              defaultLangcode: "en",
              live: {
                vid: "40",
                translations: [{ langcode: "en", default: true, status: true, name: "Still" }],
              },
              working: {
                vid: "41",
                translations: [
                  { langcode: "en", default: true, status: true, name: "Still" },
                  { langcode: "es", default: false, status: false, name: "Imagen" },
                ],
              },
            },
          };
        }
        if (String(path).endsWith("/mcp-draft") && options?.headers?.["X-MCP-Draft-Preflight"] === "1") {
          return { meta: { draft_preflight: true, live: "40", working: "41", langcode: "es" } };
        }
        throw new Error(`unexpected ${path}`);
      }),
    });
    const out = await prepareGuardedPatch(backend, {
      entityType: "media", bundle: "image", id: "m1",
      existing: { fields: { name: "Still" } },
      attributes: { name: "Imagen" },
      langcode: "es",
    });
    expect(out.liveVid).toBe(40);
    expect(out.workingVid).toBe(41);
    expect(out.draftRevision).toEqual({ liveVid: 40, workingVid: 41 });
    // #336: the draft endpoint received the real attributes.
    expect(out.preflight).toBe("sentinel_draft");
    expect(backend.updateEntity).not.toHaveBeenCalled();
    const draft = backend.rawQuery.mock.calls.find(([call]) => String(call.path).endsWith("/mcp-draft"));
    expect(draft[0].options.headers["X-MCP-Draft-Preflight"]).toBe("1");
    expect(draft[0].options.headers["X-MCP-Draft-Langcode"]).toBe("es");
  });
});

describe("prepareGuardedPatch published translation (#376)", () => {
  it("names revise: true when the language is published and there is no working copy", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async () => null),
      rawQuery: vi.fn(async ({ path }) => {
        if (String(path).endsWith("/mcp-translations")) {
          return {
            meta: {
              defaultLangcode: "en",
              live: {
                vid: "10",
                translations: [
                  { langcode: "en", status: true, title: "Company" },
                  { langcode: "es", status: true, title: "Empresa" },
                ],
              },
              working: null,
            },
          };
        }
        throw new Error(`unexpected ${path}`);
      }),
    });
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "basic_page", id: "n1",
      existing: { fields: { moderation_state: "published", drupal_internal__vid: 10 } },
      attributes: { title: "Acerca de nosotros" },
      langcode: "es",
    })).rejects.toThrow(/revise: true/);
    expect(backend.rawQuery.mock.calls.some(([call]) => String(call.path).endsWith("/mcp-draft"))).toBe(false);
  });
});

describe("prepareGuardedPatch carried published language (#400)", () => {
  it("refuses continue and revise of a carried published default language", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => {
        if (resourceVersion === "rel:working-copy") {
          throw new Error("Drupal 403: No pending revision for moderated entity.");
        }
        return { id: "n1", fields: { drupal_internal__vid: 3141, moderation_state: "published" } };
      }),
      rawQuery: vi.fn(async ({ path }) => {
        if (String(path).endsWith("/mcp-translations")) {
          return {
            meta: {
              defaultLangcode: "en",
              operations: ["create_translation", "revise_published_translation", "revise_over_working_copy"],
              live: {
                vid: "3141",
                translations: [
                  { langcode: "en", default: true, status: true, moderation_state: "published" },
                  { langcode: "es", default: false, status: true, moderation_state: "published" },
                ],
              },
              working: {
                vid: "3171",
                translations: [
                  { langcode: "en", default: true, status: false, moderation_state: "published" },
                  { langcode: "es", default: false, status: false, moderation_state: "draft" },
                ],
              },
            },
          };
        }
        throw new Error(`unexpected ${path}`);
      }),
    });
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "basic_page", id: "n1",
      existing: { status: true, fields: { moderation_state: "published", drupal_internal__vid: 3141 } },
      attributes: { title: "Federal", moderation_state: "draft" },
    })).rejects.toThrow(/3626919|#400|Publish or discard/);
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "basic_page", id: "n1",
      existing: { status: true, fields: { moderation_state: "published", drupal_internal__vid: 3141 } },
      attributes: { title: "Federal", moderation_state: "draft" },
      langcode: "en",
    })).rejects.toThrow(/3626919|#400|Publish or discard/);
  });
});

describe("prepareGuardedPatch translation still published on the working copy", () => {
  it("names revise: true instead of continuing", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async () => null),
      rawQuery: vi.fn(async ({ path }) => {
        if (String(path).endsWith("/mcp-translations")) {
          return {
            meta: {
              defaultLangcode: "en",
              live: {
                vid: "10",
                translations: [
                  { langcode: "en", status: true, title: "Company" },
                  { langcode: "es", status: true, title: "Empresa" },
                ],
              },
              working: {
                vid: "11",
                translations: [
                  { langcode: "en", status: false, title: "Company draft" },
                  { langcode: "es", status: true, title: "Empresa" },
                ],
              },
            },
          };
        }
        throw new Error(`unexpected ${path}`);
      }),
    });
    const failure = prepareGuardedPatch(backend, {
      entityType: "node", bundle: "basic_page", id: "n1",
      existing: { fields: { moderation_state: "published", drupal_internal__vid: 10 } },
      attributes: { title: "Acerca de nosotros" },
      langcode: "es",
    });
    await expect(failure).rejects.toThrow(/still published on the working copy.*revise: true/);
    expect(backend.rawQuery.mock.calls.some(([call]) => String(call.path).endsWith("/mcp-draft"))).toBe(false);
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

describe("prepareGuardedPatch default-language draft on a multilingual node (#379)", () => {
  const multilingualInventory = (enStatus, esStatus) => ({
    meta: {
      defaultLangcode: "en",
      live: {
        vid: "10",
        translations: [
          { langcode: "en", status: true, default: true },
          { langcode: "es", status: true, default: false },
        ],
      },
      working: {
        vid: "20",
        translations: [
          { langcode: "en", status: enStatus, default: true },
          { langcode: "es", status: esStatus, default: false },
        ],
      },
    },
  });
  const LANG_409 = new Error(
    "Drupal 409 on PATCH /jsonapi/node/solution/n1/mcp-draft: Translated draft continuation requires X-MCP-Draft-Langcode."
  );
  const aliasBackend = (draftHandler, inventoryHandler = async () => multilingualInventory(false, true)) => backendStub({
    getEntity: vi.fn(async ({ resourceVersion }) => (resourceVersion === "rel:working-copy"
      ? { id: "n1", fields: { drupal_internal__vid: 20, moderation_state: "draft" } }
      : { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } })),
    rawQuery: vi.fn(async ({ path, options }) => {
      if (String(path).endsWith("/mcp-translations")) return inventoryHandler();
      if (String(path).endsWith("/mcp-draft")) return draftHandler(options?.headers ?? {});
      throw new Error(`unexpected ${path}`);
    }),
  });
  const draftCalls = (backend) => backend.rawQuery.mock.calls
    .filter(([call]) => String(call.path).endsWith("/mcp-draft"))
    .map(([call]) => call.options.headers);

  it("retries with the default language after Sentinel's multilingual 409", async () => {
    const backend = aliasBackend(async (headers) => {
      if (!headers["X-MCP-Draft-Langcode"]) throw LANG_409;
      return { meta: { draft_preflight: true, live: "10", working: "20", langcode: "en" } };
    });
    const out = await prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      attributes: { title: "English draft two" },
    });
    expect(out.draftRevision).toEqual({ liveVid: 10, workingVid: 20, langcode: "en" });
    const calls = draftCalls(backend);
    expect(calls).toHaveLength(2);
    expect(calls[0]["X-MCP-Draft-Langcode"]).toBeUndefined();
    expect(calls[1]["X-MCP-Draft-Langcode"]).toBe("en");
  });

  it("keeps Sentinel's 409 when the default language is published in the working revision", async () => {
    const backend = aliasBackend(async () => { throw LANG_409; }, async () => multilingualInventory(true, false));
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      attributes: { title: "Guess" },
    })).rejects.toThrow(/X-MCP-Draft-Langcode/);
    expect(draftCalls(backend)).toHaveLength(1);
  });

  it("surfaces an inventory read failure instead of the original 409", async () => {
    const backend = aliasBackend(async () => { throw LANG_409; }, async () => { throw new Error("Drupal 403 inventory"); });
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      attributes: { title: "Guess" },
    })).rejects.toThrow(/403 inventory/);
    expect(draftCalls(backend)).toHaveLength(1);
  });

  it("refuses as stale when the working copy was published during discovery", async () => {
    const published = multilingualInventory(false, true);
    published.meta.working = null;
    const backend = aliasBackend(async () => { throw LANG_409; }, async () => published);
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      attributes: { title: "Guess" },
    })).rejects.toBeInstanceOf(WorkingCopyStaleError);
  });

  it("recognises Sentinel 2.24.2's multilingual 409 wording", async () => {
    const newWording = new Error(
      "Drupal 409 on PATCH /jsonapi/node/solution/n1/mcp-draft: This draft has more than one language. " +
      "Send X-MCP-Draft-Langcode with the language to continue, for example \"en\" for the default language."
    );
    const backend = aliasBackend(async (headers) => {
      if (!headers["X-MCP-Draft-Langcode"]) throw newWording;
      return { meta: { draft_preflight: true, live: "10", working: "20", langcode: "en" } };
    });
    const out = await prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      attributes: { title: "English draft two" },
    });
    expect(out.draftRevision.langcode).toBe("en");
  });

  it("does not retry a 409 that is not the multilingual language refusal", async () => {
    const other = new Error("Drupal 409 on PATCH /jsonapi/node/solution/n1/mcp-draft: The live or working revision changed. Reload before retrying.");
    const backend = aliasBackend(async () => { throw other; });
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      attributes: { title: "Guess" },
    })).rejects.toThrow();
    expect(draftCalls(backend)).toHaveLength(1);
    expect(backend.rawQuery.mock.calls.some(([call]) => String(call.path).endsWith("/mcp-translations"))).toBe(false);
  });

  it.each([
    "A translation cannot replace a file or image reference.",
    "moderation_state is not translatable on this bundle; omit langcode to change the shared workflow state.",
  ])("names the Sentinel release for the older translation-write refusal: %s", async (detail) => {
    const backend = aliasBackend(async (headers) => {
      if (!headers["X-MCP-Draft-Langcode"]) throw LANG_409;
      throw new Error(`Drupal 400 on PATCH /jsonapi/node/solution/n1/mcp-draft: ${detail}`);
    });
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      attributes: { title: "T" },
    })).rejects.toThrow(/MCP Sentinel 2\.24\.2 or later/);
  });

  it("refuses as stale when the inventory names a different working revision", async () => {
    const moved = multilingualInventory(false, true);
    moved.meta.working.vid = "21";
    const backend = aliasBackend(async () => { throw LANG_409; }, async () => moved);
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      attributes: { title: "Guess" },
    })).rejects.toBeInstanceOf(WorkingCopyStaleError);
    expect(draftCalls(backend)).toHaveLength(1);
  });

  it("names the default language up front when discovery already read the inventory", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async () => null),
      rawQuery: vi.fn(async ({ path, options }) => {
        if (String(path).endsWith("/mcp-translations")) return multilingualInventory(false, true);
        if (String(path).endsWith("/mcp-draft")) {
          expect(options.headers["X-MCP-Draft-Langcode"]).toBe("en");
          return { meta: { draft_preflight: true, live: "10", working: "20", langcode: "en" } };
        }
        throw new Error(`unexpected ${path}`);
      }),
    });
    const out = await prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      attributes: { title: "English draft two" },
    });
    expect(out.resourceVersion).toBe("id:20");
    expect(out.draftRevision).toEqual({ liveVid: 10, workingVid: 20, langcode: "en" });
  });

  it("still asks for an explicit langcode on a translation-only draft", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async () => null),
      rawQuery: vi.fn(async ({ path }) => {
        if (String(path).endsWith("/mcp-translations")) return multilingualInventory(true, false);
        throw new Error(`unexpected ${path}`);
      }),
    });
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      attributes: { title: "Guess" },
    })).rejects.toThrow(/explicit langcode/);
  });

  it("names the Sentinel release when an older host treats the default language as a translation write", async () => {
    const backend = aliasBackend(async (headers) => {
      if (!headers["X-MCP-Draft-Langcode"]) throw LANG_409;
      throw new Error("Drupal 400 on PATCH /jsonapi/node/solution/n1/mcp-draft: Shared references cannot be changed on a translation draft.");
    });
    await expect(prepareGuardedPatch(backend, {
      entityType: "node", bundle: "solution", id: "n1",
      existing: { id: "n1", fields: { drupal_internal__vid: 10, moderation_state: "published" } },
      relationships: { field_related: { data: [] } },
    })).rejects.toThrow(/MCP Sentinel 2\.24\.2 or later/);
  });

  it("updateEntityGuarded sends the inferred language on the real write", async () => {
    const backend = backendStub({
      rawQuery: vi.fn(async ({ options }) => {
        expect(options.headers["X-MCP-Draft-Langcode"]).toBe("en");
        expect(options.headers["X-MCP-Draft-Preflight"]).toBe("0");
        return { data: { id: "n1", type: "node--solution", attributes: {} } };
      }),
      toCanonical: vi.fn((data) => ({ id: data.id })),
    });
    await updateEntityGuarded(backend, {
      entityType: "node", bundle: "solution", id: "n1", attributes: { title: "T" },
      draftRevision: { liveVid: 10, workingVid: 20, langcode: "en" },
    });
    expect(backend.rawQuery).toHaveBeenCalledTimes(1);
  });
});

describe("revision identity (#420)", () => {
  const published = {
    id: "lib-1", status: true,
    fields: { moderation_state: "published", drupal_internal__revision_id: 20 },
  };

  it("reads each supported revision attribute and ignores a term vid", () => {
    expect(entityRevisionId({
      fields: { drupal_internal__vid: 10, drupal_internal__revision_id: 20 },
    }, "node")).toBe(10);
    expect(entityRevisionId({
      fields: { drupal_internal__revision_id: 20, drupal_internal__vid: 99 },
    }, "paragraphs_library_item")).toBe(20);
    expect(entityRevisionId({
      fields: { drupal_internal__revision_id: 8 },
    }, "block_content")).toBe(8);
    expect(entityRevisionId({
      fields: { drupal_internal__vid: 4 },
    }, "taxonomy_term")).toBeNull();
    expect(entityRevisionId({ fields: { drupal_internal__vid: 4 } })).toBe(4);
    expect(entityRevisionId({ fields: { drupal_internal__revision_id: 6 } })).toBe(6);
  });

  it("treats an echoed library default confirmed by latest-version as not a draft", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => (
        resourceVersion ? { ...published } : published
      )),
    });
    const out = await resolveWorkingCopyPatchTarget(backend, {
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id: "lib-1",
      existing: published,
    });
    expect(out.resourceVersion).toBeUndefined();
    expect(out.liveVid).toBe(20);
    expect(out.workingVid).toBe(20);
    expect(out.governedDraft).toBeUndefined();
    const queries = backend.rawQuery.mock.calls.map(([call]) => call);
    expect(queries).toHaveLength(1);
    expect(queries[0].path).toMatch(/\/mcp-translations$/);
    expect(queries.some((call) => String(call.path).includes("mcp-draft"))).toBe(false);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("refuses a library forward draft before any write", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => {
        if (resourceVersion === "rel:working-copy") {
          return { ...published, fields: { ...published.fields, drupal_internal__revision_id: 22 } };
        }
        return published;
      }),
    });
    await expect(resolveWorkingCopyPatchTarget(backend, {
      entityType: "block_content", bundle: "basic", id: "lib-1", existing: published,
    })).rejects.toBeInstanceOf(UnsupportedDraftContinuationError);
    const queries = backend.rawQuery.mock.calls.map(([call]) => call);
    expect(queries).toHaveLength(1);
    expect(queries[0].path).toMatch(/\/mcp-translations$/);
    expect(queries.some((call) => String(call.path).includes("mcp-draft"))).toBe(false);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("preflights an advertised library continuation through /mcp-draft", async () => {
    const working = {
      ...published,
      status: false,
      fields: { ...published.fields, moderation_state: "draft", drupal_internal__revision_id: 21 },
    };
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => (
        resourceVersion === "rel:working-copy" ? working : published
      )),
      rawQuery: vi.fn(async ({ path, options }) => {
        if (String(path).endsWith("/mcp-translations")) {
          return {
            meta: {
              defaultLangcode: "en",
              live: { vid: "20" },
              working: {
                vid: "21",
                translations: [{ langcode: "en", status: false, moderation_state: "draft" }],
              },
              operations: ["open_draft"],
            },
          };
        }
        expect(String(path)).toMatch(/\/mcp-draft$/);
        expect(options.headers["If-Match"]).toBe('"20:21"');
        expect(options.headers["X-MCP-Draft-Preflight"]).toBe("1");
        expect(options.headers["X-MCP-Draft-Langcode"]).toBe("en");
        const body = JSON.parse(options.body);
        expect(body.meta).toBeUndefined();
        return { meta: { draft_preflight: true, live: "20", working: "21", operation: null } };
      }),
    });
    const out = await prepareGuardedPatch(backend, {
      entityType: "paragraphs_library_item",
      bundle: "paragraphs_library_item",
      id: "lib-1",
      existing: published,
      attributes: { label: "Reusable", moderation_state: "draft" },
    });
    expect(out.resourceVersion).toBeUndefined();
    expect(out.preflight).toBe("sentinel_draft");
    expect(out.governedDraft).toEqual({ live: "20", working: "21", langcode: "en" });
    expect(backend.updateEntity).not.toHaveBeenCalled();
    expect(backend.rawQuery.mock.calls.filter(([call]) => String(call.path).includes("mcp-draft"))).toHaveLength(1);
  });

  it("does not treat a non-403 pending-revision phrase as a missing draft", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => {
        if (resourceVersion === "rel:working-copy") {
          throw new Error("Drupal 500 on GET /jsonapi/x: No pending revision for moderated entity.");
        }
        return published;
      }),
    });
    await expect(resolveWorkingCopyPatchTarget(backend, {
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id: "lib-1",
      existing: published,
    })).rejects.toBeInstanceOf(RevisionIdentityError);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("updates an unmoderated custom block without version-alias reads", async () => {
    const block = {
      id: "lib-1", status: true,
      fields: { info: "Banner", drupal_internal__revision_id: 3 },
    };
    const backend = backendStub({
      getEntity: vi.fn(async () => block),
      updateEntity: vi.fn(async () => block),
    });
    await updateEntityGuarded(backend, {
      entityType: "block_content", bundle: "basic", id: "lib-1", attributes: { info: "Banner" },
    });
    expect(backend.updateEntity).toHaveBeenCalledTimes(1);
    expect(backend.getEntity.mock.calls.map(([call]) => call.resourceVersion).every((version) => !version)).toBe(true);
  });

  it("fails closed when latest-version is not the default revision", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => {
        if (resourceVersion === "rel:working-copy") {
          throw new Error("Drupal 403: No pending revision for moderated entity.");
        }
        if (resourceVersion === "rel:latest-version") {
          return { ...published, fields: { ...published.fields, drupal_internal__revision_id: 22 } };
        }
        return published;
      }),
    });
    await expect(resolveWorkingCopyPatchTarget(backend, {
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id: "lib-1",
      existing: published,
    })).rejects.toBeInstanceOf(RevisionIdentityError);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("fails closed when the working-copy body has no revision id", async () => {
    const backend = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => (
        resourceVersion === "rel:working-copy" ? { id: "lib-1", fields: {} } : published
      )),
    });
    await expect(resolveWorkingCopyPatchTarget(backend, {
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id: "lib-1",
      existing: published,
    })).rejects.toBeInstanceOf(RevisionIdentityError);
    expect(backend.updateEntity).not.toHaveBeenCalled();
  });

  it("fails closed on a denied or failed version read", async () => {
    const denied = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => {
        if (resourceVersion === "rel:working-copy") throw new Error("Drupal 403 on GET /jsonapi/x");
        return published;
      }),
    });
    await expect(resolveWorkingCopyPatchTarget(denied, {
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id: "lib-1",
      existing: published,
    })).rejects.toThrow(/was denied/);

    const failed = backendStub({
      getEntity: vi.fn(async ({ resourceVersion }) => {
        if (resourceVersion === "rel:latest-version") throw new Error("socket hang up");
        if (resourceVersion === "rel:working-copy") {
          throw new Error("Drupal 404 on GET /jsonapi/x");
        }
        return published;
      }),
    });
    await expect(resolveWorkingCopyPatchTarget(failed, {
      entityType: "paragraphs_library_item", bundle: "paragraphs_library_item", id: "lib-1",
      existing: published,
    })).rejects.toThrow(/could not be read/);
  });
});
