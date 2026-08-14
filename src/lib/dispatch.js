/**
 * Tool dispatch — the security middleware and the tools/call entry point.
 *
 * Lives outside src/index.js (which boots a transport on import) so the
 * gate order — source governance first, then per-site security assertions,
 * then the handler — is testable per tool and per backend. Every tool call,
 * whichever backend or bridge it ends up on, flows through here: denial in
 * this module is denial on every path, with no ungoverned fallback below it.
 */

import { getSiteConfig } from "./config.js";
import { resolveSecurityConfig, assertNotReadOnly,
  assertDestructiveAllowed, assertGraphqlMutationAllowed,
  SecurityError } from "./security.js";
import { toolError, toolResult } from "./errors.js";
import { BackendCapabilityError, BackendResolutionError } from "./backends/errors.js";
import { inferOperation } from "./operations.js";
import { assertSourceGovernance, GovernanceError, GOVERNANCE_DIAGNOSTIC_TOOLS } from "./governance.js";
import { allHandlers } from "../tools/index.js";

/**
 * Derive the entity type a tool acts on, for destructive-allow assertions.
 *
 * @param {string} toolName - The MCP tool name.
 * @param {object} args     - The tool arguments.
 * @returns {string} Explicit args.entityType when present, else the suffix
 *   parsed from the tool name (e.g. "node" from "drupal_delete_node"),
 *   falling back to "entity".
 */
function extractEntityType(toolName, args) {
  if (args?.entityType) return args.entityType;
  const m = toolName.match(/^drupal_(?:delete|create|update|get|list)_(.+)$/);
  return m ? m[1] : "entity";
}

/**
 * Apply per-site governance and security assertions before dispatching.
 *
 * @param {string}   toolName - The MCP tool name.
 * @param {object}   args     - Tool arguments (may carry `site`, `id`, etc.).
 * @param {Function} handler  - The resolved tool handler.
 * @returns {Promise<*>} The handler's result.
 * @throws {GovernanceError} If the site requires source governance and the
 *   contract is not verified — checked FIRST, so no assertion below can be
 *   read as an ungoverned fallback verdict.
 * @throws {SecurityError} If the resolved policy forbids the inferred operation.
 */
export async function securityMiddleware(toolName, args, handler) {
  // Tools with no site context skip per-site checks
  if (toolName === "drupal_list_sites") return handler(args);

  const site = getSiteConfig(args?.site);

  // Source-governance gate (#176). The diagnostic tools stay callable while
  // governance fails — they are how an operator learns which condition failed.
  if (!GOVERNANCE_DIAGNOSTIC_TOOLS.has(toolName)) {
    await assertSourceGovernance(site);
  }

  const sec  = resolveSecurityConfig(site);
  const op   = inferOperation(toolName);

  if (op === "delete") {
    assertDestructiveAllowed(sec, extractEntityType(toolName, args), args?.id ?? "?");
    assertNotReadOnly(sec, toolName);
  } else if (op === "write") {
    assertNotReadOnly(sec, toolName);
  } else if (op === "graphql" && args?.query) {
    assertGraphqlMutationAllowed(sec, args.query);
  }

  return handler(args);
}

/**
 * Serve one MCP tools/call request: resolve the handler, run the middleware,
 * translate known error classes into clear, non-leaky isError envelopes.
 *
 * @param {string} name - The MCP tool name.
 * @param {object} args - The tool arguments.
 * @returns {Promise<object>} An MCP tool result payload.
 */
export async function callTool(name, args) {
  // eslint-disable-next-line security/detect-object-injection -- name is an MCP tool name from validated schema; allHandlers is a closed dispatch table built at startup
  const handler = allHandlers[name];

  if (!handler) {
    return toolError(new Error(
      `Unknown tool "${name}". Call drupal_list_entity_types to discover available resources.`
    ));
  }

  try {
    const result = await securityMiddleware(name, args ?? {}, handler);
    return toolResult(result);
  } catch (err) {
    // Translate known error classes into clear, non-leaky isError responses;
    // anything else falls through to toolError for a generic envelope.
    if (err instanceof GovernanceError) {
      return { content: [{ type: "text", text: `Source governance unavailable: ${err.message}` }], isError: true };
    }
    if (err instanceof SecurityError) {
      return { content: [{ type: "text", text: `Access denied: ${err.message}` }], isError: true };
    }
    if (err instanceof BackendCapabilityError) {
      return { content: [{ type: "text", text: `Not supported by this site's backend: ${err.message}` }], isError: true };
    }
    if (err instanceof BackendResolutionError) {
      return { content: [{ type: "text", text: `Backend resolution failed: ${err.message}` }], isError: true };
    }
    return toolError(err);
  }
}
