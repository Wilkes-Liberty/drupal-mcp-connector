/**
 * Tool dispatch — the security middleware and the tools/call entry point.
 *
 * Lives outside src/index.js (which boots a transport on import) so the
 * gate order — source governance first, then per-site security assertions,
 * then the handler — is testable per tool and per backend. Every tool call,
 * whichever backend or bridge it ends up on, flows through here: denial in
 * this module is denial on every path, with no ungoverned fallback below it.
 */

import { getSiteConfig, listSiteNames } from "./config.js";
import { resolveSecurityConfig, assertNotReadOnly,
  assertDestructiveAllowed, assertGraphqlMutationAllowed,
  SecurityError } from "./security.js";
import { toolError, toolResult } from "./errors.js";
import { BackendCapabilityError, BackendResolutionError } from "./backends/errors.js";
import { inferOperation } from "./operations.js";
import { assertSourceGovernance, GovernanceError, GOVERNANCE_DIAGNOSTIC_TOOLS } from "./governance.js";
import {
  assertPrincipalEntitlement, callerTargetHints, getRequestIdentity,
} from "./principal.js";
import { assertExplicitSiteForWrite, withResolvedTarget } from "./site-target.js";
import { allHandlers } from "../tools/index.js";

/**
 * Resolve every configured site that CAN resolve, skipping the ones that
 * throw. A site can legitimately be unresolvable on purpose — the break-glass
 * tier keeps its credential absent to stay inert — and discovery must treat
 * such a site as simply unable to serve tools, never let it kill tools/list
 * for everyone (the 2.4.0 regression). Execution against an unresolvable
 * site still surfaces its own descriptive error at call time.
 *
 * @returns {Array<object>} Resolved site configs.
 */
export function listResolvableSiteConfigs() {
  return listSiteNames().flatMap((name) => {
    try {
      return [getSiteConfig(name)];
    } catch {
      return [];
    }
  });
}

/**
 * Resolve which site this call addresses and how that name was chosen.
 * Returns null for tools that do not address a single site (`list_sites`,
 * unscoped `governance_status`).
 *
 * @param {string} toolName
 * @param {object} rawArgs Caller arguments before any rewrite.
 * @param {object} [context]
 * @returns {?{site: object, source: string, name: string}}
 * @throws {SecurityError}
 */
export function resolveCallTarget(toolName, rawArgs, context = {}) {
  if (toolName === "drupal_list_sites") return null;
  if (toolName === "drupal_governance_status" && callerTargetHints(rawArgs).length === 0) {
    return null;
  }

  const identity = context.identity !== undefined ? context.identity : getRequestIdentity();
  if (identity) {
    return assertPrincipalEntitlement({
      toolName,
      args: rawArgs,
      identity,
      sites: context.sites ?? listResolvableSiteConfigs(),
      grants: context.grants,
      defaultSite: context.defaultSite,
    });
  }

  const hints = callerTargetHints(rawArgs);
  const unique = [...new Set(hints.map((hint) => hint.value))];
  if (unique.length > 1) {
    throw new SecurityError(
      "Conflicting caller target hints do not select a single target.",
    );
  }
  const source = unique.length === 1 ? "hint" : "default";
  const site = getSiteConfig(unique[0]);
  return { site, source, name: site._name };
}

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
 * @param {object}   [context] Optional inbound identity / grant overrides (tests).
 * @returns {Promise<*>} The handler's result.
 * @throws {GovernanceError} If the site requires source governance and the
 *   contract is not verified — checked FIRST, so no assertion below can be
 *   read as an ungoverned fallback verdict.
 * @throws {SecurityError} If the resolved policy forbids the inferred operation.
 */
export async function securityMiddleware(toolName, args, handler, context = {}) {
  const rawArgs = args ?? {};
  const identity = context.identity !== undefined ? context.identity : getRequestIdentity();
  let nextArgs = rawArgs;

  const resolved = resolveCallTarget(toolName, rawArgs, { ...context, identity });
  if (context && typeof context === "object") {
    context.resolvedTarget = resolved;
  }
  assertExplicitSiteForWrite(
    toolName,
    rawArgs,
    resolved,
    context.siteNames ?? listSiteNames(),
  );

  if (identity && resolved) {
    nextArgs = { ...rawArgs, site: resolved.name };
  }

  // Tools with no site context skip per-site checks. governance_status
  // without a hint reports every granted/configured site and must not
  // resolve (or fail on) the configured default first.
  if (toolName === "drupal_list_sites") return handler(nextArgs);
  if (toolName === "drupal_governance_status" && !nextArgs.site) {
    return handler(nextArgs);
  }

  const site = getSiteConfig(nextArgs.site);

  // Source-governance gate (#176). The diagnostic tools stay callable while
  // governance fails — they are how an operator learns which condition failed.
  if (!GOVERNANCE_DIAGNOSTIC_TOOLS.has(toolName)) {
    await assertSourceGovernance(site);
  }

  const sec  = resolveSecurityConfig(site);
  const op   = inferOperation(toolName);

  if (op === "delete") {
    assertDestructiveAllowed(sec, extractEntityType(toolName, nextArgs), nextArgs?.id ?? "?");
    assertNotReadOnly(sec, toolName);
  } else if (op === "write") {
    assertNotReadOnly(sec, toolName);
  } else if (op === "graphql" && nextArgs?.query) {
    assertGraphqlMutationAllowed(sec, nextArgs.query);
  }

  return handler(nextArgs);
}

/**
 * Serve one MCP tools/call request: resolve the handler, run the middleware,
 * translate known error classes into clear, non-leaky isError envelopes.
 *
 * @param {string} name - The MCP tool name.
 * @param {object} args - The tool arguments.
 * @param {object} [context] Optional inbound identity / grant overrides.
 * @returns {Promise<object>} An MCP tool result payload.
 */
export async function callTool(name, args, context = {}) {
  // eslint-disable-next-line security/detect-object-injection -- name is an MCP tool name from validated schema; allHandlers is a closed dispatch table built at startup
  const handler = allHandlers[name];

  if (!handler) {
    return toolError(new Error(
      `Unknown tool "${name}". Call drupal_list_entity_types to discover available resources.`
    ));
  }

  try {
    const ctx = { ...context };
    const result = await securityMiddleware(name, args ?? {}, handler, ctx);
    return toolResult(withResolvedTarget(result, ctx.resolvedTarget));
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
