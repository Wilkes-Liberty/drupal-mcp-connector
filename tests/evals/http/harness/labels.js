/**
 * T1/T7 request-label twins (a-3) and the stand-in eval tool surface.
 * Live connector tools and HTTP routes are pinned in Ta5 / coverage.js (a-5).
 */

/** Stand-in tool names the eval HTTP surface exposes (not the full registry). */
export const EVAL_TOOL_NAMES = Object.freeze([
  "drupal_list_nodes",
  "drupal_create_node",
  // Eval-only name with no scope-table row (T17, DEV-862). Never live.
  "drupal_eval_unscoped",
]);

/**
 * T1 unauthenticated request labels. T7 must cover the same set as allow twins
 * (a-3), using the protocol-correct authenticated outcome for each shape.
 */
export const UNAUTHENTICATED_LABELS = Object.freeze([
  "POST initialize",
  "POST server/discover",
  "POST tools/list",
  "POST tools/call",
  "POST resources/list",
  "POST prompts/list",
  "POST ping",
  "POST notification",
  "POST empty body",
  "GET without session",
  "GET with session",
  "DELETE without session",
  "DELETE with session",
]);

