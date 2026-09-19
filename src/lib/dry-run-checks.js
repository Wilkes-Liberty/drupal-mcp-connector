/**
 * What a `dryRun` preview actually checked (#336).
 *
 * A preview that returns without a refusal reads as "this write will work".
 * That is only true for the checks that ran, and most previews run few of
 * them. Every dryRun result carries a `checks` block naming each check as
 * `checked` or `not_checked`, plus a `caveat` sentence when anything was left
 * out. `checked` always means "ran and passed": a failed check throws, so it
 * never reaches a preview.
 *
 * Three server-side preflights exist:
 *
 *  - `sentinel_draft` — Sentinel's non-saving draft endpoint. It receives the
 *    real attributes and relationships, applies them through core field
 *    access, validates the entity, and returns before saving. It predicts a
 *    field-access or validation refusal.
 *  - `core_patch_guard` — a core JSON:API PATCH with no fields and a
 *    non-matching `data.id`. The route checks entity update access and core
 *    checks the working-copy guard, then rejects the id. Core evaluates field
 *    access and validation only after the id check, so this probe says
 *    nothing about the submitted fields.
 *  - `none` — Drupal evaluated nothing about the write. The connector may
 *    still have read from Drupal (the existing entity, field definitions).
 */

/** No server-side preflight ran. */
export const PREFLIGHT_NONE = "none";

/** Core's PATCH working-copy guard was probed with an empty, id-mismatched body. */
export const PREFLIGHT_CORE_GUARD = "core_patch_guard";

/** Sentinel's non-saving draft endpoint evaluated the real payload. */
export const PREFLIGHT_SENTINEL_DRAFT = "sentinel_draft";

const CHECKED = "checked";
const NOT_CHECKED = "not_checked";

const CAVEAT_CORE_GUARD =
  "Field access and entity validation were NOT checked. The server-side probe carried no fields: " +
  "it checked entity update access and core's working-copy guard only. " +
  "The real write can still fail with a field-access 403 or a validation 422.";

const CAVEAT_NONE_WRITE =
  "Drupal did not evaluate this write. Entity access, field access and entity validation were NOT checked. " +
  "This preview shows the payload the connector would send after its own policy checks; " +
  "the real write can still fail with a 403 or a validation 422.";

const CAVEAT_NONE_DELETE =
  "Drupal did not evaluate this delete. Drupal's delete access for this entity was NOT checked; " +
  "only the connector's own policy was. The real delete can still fail with a 403 or 404.";

/**
 * Describe what a dryRun preview checked.
 *
 * Fails closed: an unknown or missing `preflight` is reported as `none`, so a
 * caller that forgets to pass it cannot claim a check that did not run.
 *
 * @param {object} args
 * @param {"create"|"update"|"delete"|string} args.operation Previewed operation.
 * @param {?string} [args.preflight] One of the PREFLIGHT_* constants.
 * @returns {{checks: {serverPreflight: string, connectorPolicy: string, entityAccess: string, revisionGuard: string, fieldAccess: string, entityValidation: string}, caveat?: string}}
 */
export function dryRunChecks({ operation, preflight } = {}) {
  const sentinel = preflight === PREFLIGHT_SENTINEL_DRAFT;
  const core = preflight === PREFLIGHT_CORE_GUARD;
  const contacted = sentinel || core;
  const checks = {
    serverPreflight: sentinel ? PREFLIGHT_SENTINEL_DRAFT : core ? PREFLIGHT_CORE_GUARD : PREFLIGHT_NONE,
    connectorPolicy: CHECKED,
    entityAccess: contacted ? CHECKED : NOT_CHECKED,
    revisionGuard: contacted ? CHECKED : NOT_CHECKED,
    fieldAccess: sentinel ? CHECKED : NOT_CHECKED,
    entityValidation: sentinel ? CHECKED : NOT_CHECKED,
  };
  if (sentinel) return { checks };
  if (core) return { checks, caveat: CAVEAT_CORE_GUARD };
  return { checks, caveat: operation === "delete" ? CAVEAT_NONE_DELETE : CAVEAT_NONE_WRITE };
}
