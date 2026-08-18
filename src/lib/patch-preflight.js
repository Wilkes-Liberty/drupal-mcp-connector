/**
 * JSON:API PATCH preflight for Drupal core's working-copy guard (#201).
 *
 * `EntityResource::patchIndividual()` rejects a canonical PATCH when the
 * stored entity is not both the latest and the default revision. That check
 * runs against the revision table *before* the payload is deserialized.
 * An empty-body PATCH that returns 2xx still calls `$entity->save()` (and
 * often `setNewRevision`) — so the probe must fail *after* the guard and
 * *before* save. Core next compares `data.id` to the URL entity UUID; a
 * well-formed but non-matching id yields 400 "does not match the ID in the
 * payload" with no row written. Content-moderation's `rel:latest-version` /
 * `rel:working-copy` aliases can disagree with storage (a revision row with
 * no `content_moderation_state`), which is how every read tool reports
 * clean and the write then 400s.
 *
 * `workingCopy: null` and "latest-version vid === default vid" are not proof
 * the node is writable. That is the #201 lie.
 *
 * Distinct from #166: there a working copy is visible and the fix is PATCH
 * `?resourceVersion=rel:working-copy`. This module does not implement that.
 */

import { entityLooksModerated, hasExplicitModerationState } from "./moderation-default.js";

/** Stable error code for a core working-copy / not-latest-revision block. */
export const PATCH_BLOCKED_CODE = "PATCH_BLOCKED";

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
 * Read a revision id off a working-copy body (canonical or raw-ish).
 * @param {?object} workingCopy
 * @returns {?number|string}
 */
function workingCopyVid(workingCopy) {
  if (!workingCopy || typeof workingCopy !== "object") return null;
  const fields = workingCopy.fields && typeof workingCopy.fields === "object"
    ? workingCopy.fields
    : {};
  const attrs = workingCopy.attributes && typeof workingCopy.attributes === "object"
    ? workingCopy.attributes
    : {};
  const raw = workingCopy.vid
    ?? fields.drupal_internal__vid
    ?? attrs.drupal_internal__vid
    ?? workingCopy.drupal_internal__vid;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

/**
 * Operator message for a core working-copy 400.
 * A resolvable working copy is an ordinary pending draft — do not prescribe
 * revision surgery. Surgery is only for the invisible-row case (#201 follow-up).
 * @param {?object} [workingCopy]
 * @returns {string}
 */
export function patchBlockedMessage(workingCopy) {
  if (workingCopy) {
    const vid = workingCopyVid(workingCopy);
    const which = vid !== null && vid !== undefined ? ` (vid ${vid})` : "";
    return `This node has a pending draft${which}. Publish or discard it `
      + "before a canonical PATCH.";
  }
  return PATCH_BLOCKED_MESSAGE;
}

/**
 * Thrown when the core working-copy PATCH guard rejects a write (or its probe).
 */
export class PatchBlockedError extends Error {
  /**
   * @param {?Error} [cause] The original Drupal 400.
   * @param {{workingCopy?: ?object}} [options]
   */
  constructor(cause, { workingCopy } = {}) {
    super(patchBlockedMessage(workingCopy ?? null));
    this.name = "PatchBlockedError";
    this.code = PATCH_BLOCKED_CODE;
    if (workingCopy) this.workingCopyVid = workingCopyVid(workingCopy);
    if (cause) this.cause = cause;
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
 * return the original value. Pass `workingCopy` when the pending draft is
 * addressable so the message does not prescribe revision surgery.
 * @param {unknown} err
 * @param {{workingCopy?: ?object}} [options]
 * @returns {unknown}
 */
export function rewriteWorkingCopyPatchError(err, { workingCopy } = {}) {
  if (!isWorkingCopyPatchError(err)) return err;
  return new PatchBlockedError(
    err instanceof Error ? err : new Error(String(err)),
    { workingCopy },
  );
}

/**
 * Load `rel:working-copy` so a blocked PATCH can name a pending draft.
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string}} ref
 * @returns {Promise<?object>}
 */
async function loadWorkingCopy(backend, { entityType, bundle, id }) {
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
 * Probe the same guard core uses on the canonical PATCH URL.
 *
 * Sends a PATCH whose `data.id` does not match the URL entity. Core runs
 * the working-copy check first; a match on that phrase means no row was
 * written. An id-mismatch 400 (or deserialize 422) means the guard passed
 * and save was not reached. A 2xx would have saved a revision and is
 * treated as a probe failure. Do not treat "latest-version vid === default
 * vid" as writable.
 *
 * @param {object} args
 * @param {object} args.backend Backend with `rawQuery` + `resourcePath`.
 * @param {string} args.entityType
 * @param {string} args.bundle
 * @param {string} args.id
 * @param {?object} [args.existing]
 * @param {object} [args.attributes]
 * @returns {Promise<{probed: boolean, writable?: boolean|string, skipped?: string}>}
 * @throws {PatchBlockedError} When the guard rejects the probe.
 */
export async function preflightPatchWritable({
  backend, entityType, bundle, id, existing, attributes,
}) {
  if (!shouldPreflightPatch({ existing, attributes })) {
    return { probed: false };
  }
  if (typeof backend?.rawQuery !== "function" || typeof backend?.resourcePath !== "function") {
    return { probed: false, skipped: "backend cannot issue a raw PATCH probe" };
  }
  const path = `${backend.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}`;
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
      const workingCopy = await loadWorkingCopy(backend, { entityType, bundle, id });
      throw new PatchBlockedError(
        err instanceof Error ? err : new Error(String(err)),
        { workingCopy },
      );
    }
    if (isProbePassedWithoutSave(err)) {
      return { probed: true, writable: true };
    }
    throw err;
  }
}

/**
 * `backend.updateEntity` with the core working-copy 400 rewritten.
 * @param {object} backend
 * @param {object} input updateEntity argument.
 * @returns {Promise<*>}
 * @throws {PatchBlockedError|*}
 */
export async function updateEntityGuarded(backend, input) {
  try {
    return await backend.updateEntity(input);
  } catch (err) {
    if (!isWorkingCopyPatchError(err)) throw err;
    const workingCopy = await loadWorkingCopy(backend, input);
    throw rewriteWorkingCopyPatchError(err, { workingCopy });
  }
}
