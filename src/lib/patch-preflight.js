/**
 * JSON:API PATCH preflight and working-copy targeting (#201 / #166).
 *
 * `EntityResource::patchIndividual()` rejects a canonical PATCH when the
 * stored entity is not both the latest and the default revision. That check
 * runs against the revision table *before* the payload is deserialized.
 * An empty-body PATCH that returns 2xx still calls `$entity->save()` (and
 * often `setNewRevision`) — so the probe must fail *after* the guard and
 * *before* save. Core next compares `data.id` to the URL entity UUID; a
 * well-formed but non-matching id yields 400 "does not match the ID in the
 * payload" with no row written.
 *
 * Two distinct cases share that core 400:
 *
 * - **#166** — `rel:working-copy` resolves. Both preflight and write use
 *   Sentinel's /mcp-draft endpoint with verified live/working revision IDs.
 *   Core rejects resourceVersion on PATCH. Never retry the canonical URL.
 * - **#201** — the working-copy alias does not resolve, but core still
 *   blocks. That is a stray revision row. Refuse with revision-surgery
 *   language. `workingCopy: null` is not proof the node is writable.
 *
 * Unsupported endpoints and stale revisions fail closed, without discard.
 */

import { entityLooksModerated, hasExplicitModerationState } from "./moderation-default.js";
import { entityRevisionId } from "./write-revision.js";
import { writeDraft } from "./draft-write.js";

/** Stable error code for a core working-copy / not-latest-revision block. */
export const PATCH_BLOCKED_CODE = "PATCH_BLOCKED";

/** Stable error code when a working-copy PATCH itself is rejected. */
export const PATCH_WORKING_COPY_STALE_CODE = "PATCH_WORKING_COPY_STALE";

/** Stable error code when the working-copy resource does not match the target. */
export const PATCH_TARGET_AMBIGUOUS_CODE = "PATCH_TARGET_AMBIGUOUS";

const WORKING_COPY_PATCH_RE = /has a working copy is not yet supported/i;

/**
 * Actionable replacement for core's "has a working copy" 400 when no
 * content_moderation working copy is addressable — a stray revision row.
 */
export const PATCH_BLOCKED_MESSAGE =
  "This entity cannot be updated over JSON:API because the stored entity is not " +
  "the latest revision (Drupal core #2795279). The JSON:API aliases " +
  "rel:latest-version and rel:working-copy cannot show the blocking row. " +
  "Clearing it requires revision surgery outside JSON:API (Drush / the entity API). " +
  "See connector #201. Do not retry the same canonical PATCH.";

/**
 * A working-copy-targeted PATCH (or its probe) hit core's working-copy guard.
 * That is a stale or concurrent conflict, not an invitation to discard.
 */
export const PATCH_WORKING_COPY_STALE_MESSAGE =
  "This entity's working-copy revision could not be updated (stale or concurrent write). " +
  "The connector will not retry the canonical URL or discard the draft. " +
  "Re-read rel:working-copy and retry, or resolve the conflict in Drupal. See connector #166.";

/**
 * Operator message for a core working-copy 400.
 * A resolvable working copy is edited in place (#166) — this message is only
 * for the invisible-row case (#201).
 * @returns {string}
 */
export function patchBlockedMessage() {
  return PATCH_BLOCKED_MESSAGE;
}

/**
 * Thrown when the core working-copy PATCH guard rejects a canonical write
 * (or its probe) and no working copy is addressable (#201).
 */
export class PatchBlockedError extends Error {
  /**
   * @param {?Error} [cause] The original Drupal 400.
   */
  constructor(cause) {
    super(PATCH_BLOCKED_MESSAGE);
    this.name = "PatchBlockedError";
    this.code = PATCH_BLOCKED_CODE;
    if (cause) this.cause = cause;
  }
}

/**
 * Thrown when a working-copy-targeted PATCH or probe is rejected (#166).
 */
export class WorkingCopyStaleError extends Error {
  /**
   * @param {?Error} [cause] The original Drupal 400.
   */
  constructor(cause) {
    super(PATCH_WORKING_COPY_STALE_MESSAGE);
    this.name = "WorkingCopyStaleError";
    this.code = PATCH_WORKING_COPY_STALE_CODE;
    if (cause) this.cause = cause;
  }
}

/**
 * Thrown when `rel:working-copy` resolves to a different UUID than the
 * entity being updated.
 */
export class PatchTargetAmbiguousError extends Error {
  /**
   * @param {string} expectedId Requested entity UUID.
   * @param {string} actualId Working-copy resource UUID.
   */
  constructor(expectedId, actualId) {
    super(
      `The working-copy resource id (${actualId}) does not match the entity ` +
      `being updated (${expectedId}). Refusing an ambiguous PATCH target. ` +
      "See connector #166."
    );
    this.name = "PatchTargetAmbiguousError";
    this.code = PATCH_TARGET_AMBIGUOUS_CODE;
  }
}

/**
 * Whether an error is Drupal core's working-copy PATCH guard (core #2795279).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isWorkingCopyPatchError(err) {
  return WORKING_COPY_PATCH_RE.test(String(err?.message || ""));
}

/**
 * Rewrite a core working-copy 400 into {@link PatchBlockedError}; otherwise
 * return the original value. Used only for the stray-revision (#201) case.
 * @param {unknown} err
 * @returns {unknown}
 */
export function rewriteWorkingCopyPatchError(err) {
  if (!isWorkingCopyPatchError(err)) return err;
  return new PatchBlockedError(err instanceof Error ? err : new Error(String(err)));
}

/**
 * Load `rel:working-copy` so a write can target the pending draft (#166).
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string}} ref
 * @returns {Promise<?object>}
 */
export async function loadWorkingCopy(backend, { entityType, bundle, id }) {
  if (typeof backend?.getEntity !== "function") return null;
  try {
    const wc = await backend.getEntity({
      entityType, bundle, id, resourceVersion: "rel:working-copy",
    });
    return wc || null;
  } catch {
    return null;
  }
}

/**
 * Decide whether this PATCH should target `rel:working-copy`.
 *
 * A 200 from the working-copy alias is treated as an addressable draft unless
 * both live and working vids are known and equal (the alias echoed the
 * default revision). An id mismatch is refused rather than guessed.
 *
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string, existing?: ?object}} ref
 * @returns {Promise<{resourceVersion: ?string, workingCopy: ?object, liveVid: ?number|string, workingVid: ?number|string}>}
 * @throws {PatchTargetAmbiguousError}
 */
export async function resolveWorkingCopyPatchTarget(backend, { entityType, bundle, id, existing }) {
  const workingCopy = await loadWorkingCopy(backend, { entityType, bundle, id });
  let liveVid = entityRevisionId(existing);
  if (workingCopy && (liveVid === null || liveVid === undefined) && typeof backend?.getEntity === "function") {
    const live = await backend.getEntity({ entityType, bundle, id }).catch(() => null);
    liveVid = entityRevisionId(live);
  }
  if (!workingCopy) {
    return { resourceVersion: undefined, workingCopy: null, liveVid, workingVid: null };
  }
  if (workingCopy.id && workingCopy.id !== id) {
    throw new PatchTargetAmbiguousError(id, workingCopy.id);
  }
  const workingVid = entityRevisionId(workingCopy);
  if (workingVid !== null && liveVid !== null && String(workingVid) === String(liveVid)) {
    return { resourceVersion: undefined, workingCopy, liveVid, workingVid };
  }
  return { resourceVersion: "rel:working-copy", workingCopy, liveVid, workingVid };
}

/**
 * Whether this update should run the PATCH probe.
 * Skip unmoderated / non-revisionable bundles — the guard is about
 * revisionable entities under content_moderation.
 * @param {{existing?: ?object, attributes?: object}} input
 * @returns {boolean}
 */
export function shouldPreflightPatch({ existing, attributes } = {}) {
  if (hasExplicitModerationState(attributes)) return true;
  return entityLooksModerated(existing);
}

/**
 * UUID used as `data.id` on the probe PATCH so it cannot match the URL
 * entity. Core throws after the working-copy guard and before save.
 * @see EntityResource::patchIndividual()
 */
export const PATCH_PROBE_MISMATCH_ID = "00000000-0000-4000-a000-000000000001";

const ID_MISMATCH_RE = /does not match the ID in the payload/i;

/**
 * Whether a probe error means the working-copy guard passed and no row
 * was written (id mismatch, or a 422 during deserialize).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isProbePassedWithoutSave(err) {
  const msg = String(err?.message || "");
  return ID_MISMATCH_RE.test(msg) || /Drupal 422\b/.test(msg);
}

/**
 * Probe the same guard core uses on the PATCH about to be sent.
 *
 * Sends a PATCH whose `data.id` does not match the URL entity. Core runs
 * the working-copy check first; a match on that phrase means no row was
 * written. An id-mismatch 400 (or deserialize 422) means the guard passed
 * and save was not reached. A 2xx would have saved a revision and is
 * treated as a probe failure.
 *
 * When `resourceVersion` is `rel:working-copy`, the probe hits that same
 * URL so dryRun cannot succeed when the real write would 400 (#166).
 *
 * @param {object} args
 * @param {object} args.backend Backend with `rawQuery` + `resourcePath`.
 * @param {string} args.entityType
 * @param {string} args.bundle
 * @param {string} args.id
 * @param {?object} [args.existing]
 * @param {object} [args.attributes]
 * @param {?string} [args.resourceVersion]
 * @returns {Promise<{probed: boolean, writable?: boolean|string, skipped?: string}>}
 * @throws {PatchBlockedError|WorkingCopyStaleError} When the guard rejects the probe.
 */
export async function preflightPatchWritable({
  backend, entityType, bundle, id, existing, attributes, resourceVersion,
}) {
  if (!shouldPreflightPatch({ existing, attributes })) {
    return { probed: false };
  }
  if (typeof backend?.rawQuery !== "function" || typeof backend?.resourcePath !== "function") {
    return { probed: false, skipped: "backend cannot issue a raw PATCH probe" };
  }
  let path = `${backend.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}`;
  if (resourceVersion) {
    path += `?resourceVersion=${encodeURIComponent(resourceVersion)}`;
  }
  const type = `${entityType}--${bundle}`;
  const probeId = id === PATCH_PROBE_MISMATCH_ID
    ? "00000000-0000-4000-a000-000000000002"
    : PATCH_PROBE_MISMATCH_ID;
  try {
    await backend.rawQuery({
      path,
      options: {
        method: "PATCH",
        body: JSON.stringify({ data: { type, id: probeId } }),
      },
    });
    throw new Error(
      "PATCH probe unexpectedly succeeded (2xx). The probe must fail after " +
      "core's working-copy guard so no revision is written."
    );
  } catch (err) {
    if (isWorkingCopyPatchError(err)) {
      const cause = err instanceof Error ? err : new Error(String(err));
      if (resourceVersion === "rel:working-copy") {
        throw new WorkingCopyStaleError(cause);
      }
      const workingCopy = await loadWorkingCopy(backend, { entityType, bundle, id });
      if (workingCopy) {
        throw new WorkingCopyStaleError(cause);
      }
      throw new PatchBlockedError(cause);
    }
    if (isProbePassedWithoutSave(err)) {
      return { probed: true, writable: true };
    }
    throw err;
  }
}

/**
 * Resolve the PATCH target, then run the same probe the real write will use.
 * Callers inherit #166 targeting by going through this before dryRun or write.
 *
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string, existing?: ?object, attributes?: object}} args
 * @returns {Promise<{resourceVersion: ?string, workingCopy: ?object, liveVid: ?number|string, workingVid: ?number|string}>}
 */
export async function prepareGuardedPatch(backend, {
  entityType, bundle, id, existing, attributes, relationships,
}) {
  const target = shouldPreflightPatch({ existing, attributes })
    ? await resolveWorkingCopyPatchTarget(backend, { entityType, bundle, id, existing })
    : { resourceVersion: undefined, workingCopy: null, liveVid: null, workingVid: null };
  if (target.resourceVersion) {
    target.draftRevision = { liveVid: target.liveVid, workingVid: target.workingVid };
    await writeDraft(backend, {
      entityType, bundle, id, attributes, relationships, draftRevision: target.draftRevision,
    }, true);
    return target;
  }
  await preflightPatchWritable({
    backend, entityType, bundle, id, existing, attributes,
    resourceVersion: target.resourceVersion,
  });
  return target;
}

/**
 * `backend.updateEntity` with the core working-copy 400 rewritten.
 * A working-copy-targeted 400 is stale/concurrent (#166). A canonical 400
 * with no addressable working copy is the #201 stray-revision case.
 * @param {object} backend
 * @param {object} input updateEntity argument.
 * @returns {Promise<*>}
 * @throws {PatchBlockedError|WorkingCopyStaleError|*}
 */
export async function updateEntityGuarded(backend, input) {
  try {
    if (input?.draftRevision) return await writeDraft(backend, input);
    if (input?.resourceVersion) {
      throw new Error("Core JSON:API does not support revision-selected PATCH. A governed draft preflight is required.");
    }
    return await backend.updateEntity(input);
  } catch (err) {
    if (!isWorkingCopyPatchError(err)) throw err;
    const cause = err instanceof Error ? err : new Error(String(err));
    if (input?.resourceVersion === "rel:working-copy") {
      throw new WorkingCopyStaleError(cause);
    }
    const workingCopy = await loadWorkingCopy(backend, input);
    if (workingCopy) {
      throw new WorkingCopyStaleError(cause);
    }
    throw new PatchBlockedError(cause);
  }
}
