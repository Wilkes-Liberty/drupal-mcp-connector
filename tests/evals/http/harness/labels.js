/**
 * Pinned request-label and route sets (DEV-866 increment 2, a-5).
 *
 * The pack fails if these drift from `manifest.json`, or if src grows a
 * route that is not listed. Cases import the same arrays so T1/T7 cannot
 * silently drop a shape.
 */

import { EDGE_NORTHBOUND_AUX_ROUTES, httpHandler } from "./connector.js";

/** Stand-in tool names the eval surface exposes. A new name needs a case. */
export const EVAL_TOOL_NAMES = Object.freeze([
  "drupal_list_nodes",
  "drupal_create_node",
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

/** #452 / #451 HTTP routes the pack must pin. */
export function srcRoutes() {
  return [
    ...httpHandler.UNAUTHENTICATED_ROUTES.map((route) => ({
      method: route.method,
      path: route.path,
    })),
    ...httpHandler.MCP_HTTP_METHODS.map((method) => ({
      method,
      path: httpHandler.MCP_HTTP_PATH,
    })),
    ...EDGE_NORTHBOUND_AUX_ROUTES.map((route) => ({
      method: route.method,
      path: route.path,
    })),
  ];
}
