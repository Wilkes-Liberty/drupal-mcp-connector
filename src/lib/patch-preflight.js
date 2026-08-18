/**
 * JSON:API PATCH preflight for Drupal core's working-copy guard (#201).
 *
 * `EntityResource::patchIndividual()` rejects a canonical PATCH when the
 * stored entity is not both the latest and the default revision. That check
 * runs against the revision table *before* the payload is deserialized, so a
 * no-op PATCH against the same URL is a true probe: 400 means no row is
 * written. Content-moderation's `rel:latest-version` / `rel:working-copy`
 * aliases can disagree with storage (a revision row with no
 * `content_moderation_state`), which is how every read tool reports clean
 * and the write then 400s.
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
 * Actionable replacement for core's "has a working copy" 400.
 * Clearing the blocking row is revision surgery outside JSON:API.
 */
export const PATCH_BLOCKED_MESSAGE =
  "This entity cannot be updated over JSON:API because the stored entity is not " +
  "the latest revision (Drupal core #2795279). The JSON:API aliases " +
  "rel:latest-version and rel:working-copy cannot show the blocking row. " +
  "Clearing it requires revision surgery outside JSON:API (Drush / the entity API). " +
  "See connector #201. Do not retry the same canonical PATCH.";

/**
 * Thrown when the core working-copy PATCH guard rejects a write (or its probe).
 */
export class PatchBlockedError extends Error {
  /** @param {?Error} [cause] The original Drupal 400. */
  constructor(cause) {
    super(PATCH_BLOCKED_MESSAGE);
    this.name = "PatchBlockedError";
    this.code = PATCH_BLOCKED_CODE;
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
 * return the original value.
 * @param {unknown} err
 * @returns {unknown}
 */
export function rewriteWorkingCopyPatchError(err) {
  if (!isWorkingCopyPatchError(err)) return err;
  return new PatchBlockedError(err instanceof Error ? err : new Error(String(err)));
}

/**
 * Whether this update should run the no-op PATCH probe.
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
 * An empty-body PATCH can 422 when Drupal wants at least one field. That is
 * not a writability signal — the real write still has a body.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isInconclusiveEmptyPatchError(err) {
  return /Drupal 422\b/.test(String(err?.message || ""));
}

/**
 * Probe the same guard core uses on the canonical PATCH URL.
 *
 * Sends a PATCH with type + id and no attributes or relationships. Core
 * rejects before deserialize when the stored entity is not the latest
 * revision, so a 400 matching the working-copy phrase means no row was
 * written. Do not treat "latest-version vid === default vid" as writable.
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
  try {
    await backend.rawQuery({
      path,
      options: {
        method: "PATCH",
        body: JSON.stringify({ data: { type, id } }),
      },
    });
    return { probed: true, writable: true };
  } catch (err) {
    if (isWorkingCopyPatchError(err)) {
      throw new PatchBlockedError(err instanceof Error ? err : new Error(String(err)));
    }
    if (isInconclusiveEmptyPatchError(err)) {
      return { probed: true, writable: "unknown" };
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
    throw rewriteWorkingCopyPatchError(err);
  }
}
