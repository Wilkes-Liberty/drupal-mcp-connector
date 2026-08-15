/**
 * Shape a write tool's response.
 *
 * Write tools return the full re-read entity by default, which for a node with a
 * populated body is several thousand tokens per call — most of it unrelated to
 * the change, and with `body.value` and `body.processed` both included in full
 * (#113). The primary consumer is an agent with a bounded context window, so a
 * bulk operation (e.g. tagging many nodes) can exhaust the window on echoed
 * bodies. `returning: "minimal"` opts into an identity + state summary that is
 * enough to confirm the write.
 */

// Base fields promoted onto a canonical entity that a caller needs to verify a
// write. Non-base fields (body, arbitrary attributes, relationships) are omitted
// in minimal mode. Internal keys prefixed with `_` (e.g. `_redirect`) are
// preserved separately so tool-specific metadata is not lost.
const MINIMAL_KEYS = ["id", "entityType", "bundle", "title", "status", "moderation_state", "langcode", "changed", "url"];

/**
 * @param {object|null} entity Canonical entity (or a write result wrapping one).
 * @param {"full"|"minimal"} [returning] Response verbosity. Defaults to "full".
 * @returns {object|null} The entity, or a compact identity+state summary.
 */
export function shapeWriteResponse(entity, returning = "full") {
  if (!entity || returning !== "minimal") return entity;
  const out = {};
  for (const key of MINIMAL_KEYS) {
    if (entity[key] !== undefined && entity[key] !== null) out[key] = entity[key];
  }
  // Preserve tool-specific metadata keys (e.g. `_redirect` from a node rename).
  for (const key of Object.keys(entity)) {
    if (key.startsWith("_")) out[key] = entity[key];
  }
  return out;
}

/**
 * Flag a published-state change the caller never requested (#171).
 *
 * `status` is strictly opt-in on updates: the connector never adds it to a
 * PATCH. A server-side gate can still flip it (e.g. a governance backstop
 * unpublishing an unmoderated entity, or a write landing as an unpublished
 * forward revision), and a silent success that also changed live state is the
 * failure class that surfaces only when content goes missing. When a
 * pre-write read is available and the sent attributes carry neither `status`
 * nor `moderation_state` (an explicit moderation transition legitimately
 * changes the published state, as does the #131 injected draft default), a
 * different `status` in the write result is surfaced as `_statusChanged` — an
 * `_`-prefixed key, so it survives `returning: "minimal"`.
 *
 * Best-effort by design: it requires a readable pre-write entity, and the
 * server-side gate stays authoritative either way.
 *
 * @param {?object} result The entity returned by (or re-read after) the write.
 * @param {?object} existing The pre-write entity, when it could be read.
 * @param {object} sentAttributes The attribute map that was sent.
 * @returns {?object} The result, with `_statusChanged` attached when it applies.
 */
export function flagUnrequestedStatusChange(result, existing, sentAttributes) {
  if (!result || !existing) return result;
  const sent = (key) => Object.prototype.hasOwnProperty.call(sentAttributes, key);
  if (sent("status") || sent("moderation_state")) return result;
  if (typeof existing.status !== "boolean" || typeof result.status !== "boolean") return result;
  if (existing.status === result.status) return result;
  return {
    ...result,
    _statusChanged: {
      from: existing.status,
      to: result.status,
      note: "The returned published status differs from the pre-write state although the request did not " +
        "include `status`. A server-side gate intervened — the write may have landed as an unpublished " +
        "forward revision (live revision unchanged) or the entity may have been unpublished. Verify which " +
        "revision is live before relying on this content's visibility.",
    },
  };
}

/** JSON Schema fragment for the shared `returning` parameter. */
export const RETURNING_SCHEMA = {
  type: "string",
  enum: ["full", "minimal"],
  default: "full",
  description:
    "Response verbosity. \"full\" (default) returns the complete saved entity; " +
    "\"minimal\" returns just identity + state (id, type, bundle, title, status, changed, url) — " +
    "much smaller, recommended for bulk writes where the echoed body would dominate the response.",
};
