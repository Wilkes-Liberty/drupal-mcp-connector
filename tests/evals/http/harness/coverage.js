/**
 * a-5 live coverage pin.
 *
 * Expected tools come from `allDefinitions` (the connector tool registry).
 * Expected routes come from the transport tables (`UNAUTHENTICATED_ROUTES`,
 * `MCP_HTTP_METHODS` × `MCP_HTTP_PATH`, `EDGE_NORTHBOUND_AUX_ROUTES`).
 * Neither set is hand-copied here.
 *
 * `coverage.json` is only the case *assignment* (tool/route → case id). A
 * live name missing from that assignment, or an assignment pointing at a
 * case that is not in the pack, fails Ta5.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allDefinitions } from "../../../../src/tools/index.js";
import {
  MCP_HTTP_METHODS,
  MCP_HTTP_PATH,
  UNAUTHENTICATED_ROUTES,
} from "../../../../src/lib/http-handler.js";
import { EDGE_NORTHBOUND_AUX_ROUTES } from "../../../../src/lib/relay/edge.js";

/** Synthetic name used only by the Ta5-add-orphan mutant. Not a real tool. */
export const ORPHAN_TOOL = "drupal_eval_orphan_no_case";

/** Case the delete-case mutant removes from the pack. */
export const DELETED_CASE = "T16";

const ASSIGNMENT_PATH = fileURLToPath(new URL("../coverage.json", import.meta.url));

/**
 * Live tool names the HTTPS server exposes through tools/list.
 * @returns {string[]}
 */
export function liveTools() {
  return allDefinitions.map((definition) => definition.name).sort();
}

/**
 * Live HTTP route/method shapes from the transport tables.
 * @returns {string[]}
 */
export function liveRoutes() {
  const routes = [
    ...UNAUTHENTICATED_ROUTES.map((route) => `${route.method} ${route.path}`),
    ...MCP_HTTP_METHODS.map((method) => `${method} ${MCP_HTTP_PATH}`),
    ...EDGE_NORTHBOUND_AUX_ROUTES.map((route) => `${route.method} ${route.path}`),
  ];
  return [...new Set(routes)].sort();
}

/**
 * Case assignment checked against the live sets.
 * @returns {{tools: Record<string, string>, routes: Record<string, string>}}
 */
export function loadAssignment() {
  const raw = JSON.parse(readFileSync(ASSIGNMENT_PATH, "utf8"));
  return { tools: raw.tools || {}, routes: raw.routes || {} };
}

/**
 * Apply a Ta5 mutant to the live inventory / pack case list.
 *
 * @param {string|null} mutant
 * @param {{tools: string[], routes: string[], packCases: string[]}} inventory
 * @returns {{tools: string[], routes: string[], packCases: string[]}}
 */
export function applyCoverageMutant(mutant, inventory) {
  if (mutant === "Ta5-add-orphan") {
    return { ...inventory, tools: [...inventory.tools, ORPHAN_TOOL] };
  }
  if (mutant === "Ta5-delete-case") {
    return { ...inventory, packCases: inventory.packCases.filter((id) => id !== DELETED_CASE) };
  }
  return inventory;
}

/**
 * Counted assertions: every live tool and route has a covering case that
 * is still in the pack, and the assignment has no extras.
 *
 * @param {object} h
 * @param {{tools: string[], routes: string[], packCases: string[]}} inventory
 * @param {{tools: Record<string, string>, routes: Record<string, string>}} assignment
 * @param {(h: object, label: string, actual: unknown, expected: unknown) => void} expectEqual
 */
export function assertLiveCoverage(h, inventory, assignment, expectEqual) {
  for (const tool of inventory.tools) {
    const caseId = assignment.tools[tool];
    expectEqual(h, `a-5: tool ${tool} has a covering case`, Boolean(caseId), true);
    expectEqual(h, `a-5: covering case ${caseId} is in the pack`, inventory.packCases.includes(caseId), true);
  }
  const extraTools = Object.keys(assignment.tools).filter((name) => !inventory.tools.includes(name)).sort();
  expectEqual(h, "a-5: assignment tools equal the live registry", extraTools, []);

  for (const route of inventory.routes) {
    const caseId = assignment.routes[route];
    expectEqual(h, `a-5: route ${route} has a covering case`, Boolean(caseId), true);
    expectEqual(h, `a-5: covering case ${caseId} is in the pack`, inventory.packCases.includes(caseId), true);
  }
  const extraRoutes = Object.keys(assignment.routes).filter((name) => !inventory.routes.includes(name)).sort();
  expectEqual(h, "a-5: assignment routes equal the live route table", extraRoutes, []);
}
