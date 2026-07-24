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
