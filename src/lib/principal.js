/**
 * Inbound principal entitlement (#178).
 *
 * HTTPS resource-server requests carry a validated JWT identity. Discovery
 * and invocation are filtered by that identity's server-resolved grants.
 * Stdio, loopback shared-bearer, and unauthenticated loopback have no
 * inbound principal and keep the existing site + source-governance filter
 * so a local operator is not hollowed out.
 *
 * Caller-supplied site, environment, tenant, target, or scope fields are
 * hints. They never become authority. Empty inbound scopes are no grants,
 * not a wildcard.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getDefaultSiteName, getInboundGrants } from "./config.js";
import { inferOperation } from "./operations.js";
import { resolveSecurityConfig, SecurityError } from "./security.js";

const identityStore = new AsyncLocalStorage();

/** Caller fields that look like a target but are never authority. */
export const TARGET_HINT_KEYS = Object.freeze(["site", "environment", "tenant", "target"]);

/** Always discoverable; they are how an operator sees a denial. */
export const DIAGNOSTIC_TOOLS = new Set([
  "drupal_list_sites",
  "drupal_governance_status",
]);

const CONFIG_TOOLS = new Set([
  "drupal_config_get",
  "drupal_config_list",
  "drupal_config_set",
  "drupal_drush_config_export",
  "drupal_drush_config_import",
  "drupal_drush_config_status",
]);

/** inferOperation() leaves these as "read"; they self-gate in-handler. */
const WRITE_BY_NAME = new Set([
  "drupal_entity_create",
  "drupal_entity_update",
  "drupal_entity_delete",
]);

const FREE_FORM_TOOLS = new Set([
  "drupal_graphql",
  "drupal_graphql_introspect",
  "drupal_drush_sql_query",
]);

const WRITE_WORKFLOW_PROMPTS = new Set([
  "drupal-create-article",
  "drupal-seo-fix",
  "drupal-user-cleanup",
]);

const READ_WORKFLOW_PROMPTS = new Set([
  "drupal-content-audit",
  "drupal-full-audit",
]);

/**
 * Run `fn` with `identity` as the request principal (null = local operator).
 * @param {object|null} identity
 * @param {Function} fn
 * @returns {*}
 */
export function runWithIdentity(identity, fn) {
  return identityStore.run({ identity: identity ?? null }, fn);
}

/**
 * The inbound identity for the current request, or null on stdio / loopback.
 * @returns {object|null}
 */
export function getRequestIdentity() {
  return identityStore.getStore()?.identity ?? null;
}

/**
 * Inbound scope required to discover or invoke a tool. Diagnostics need none.
 * @param {string} toolName
 * @returns {string|null}
 */
export function requiredScopeForTool(toolName) {
  if (DIAGNOSTIC_TOOLS.has(toolName)) return null;
  if (toolName === "drupal_drush_sql_query") return "mcp_admin";
  if (CONFIG_TOOLS.has(toolName)) return "mcp_config";
  if (WRITE_BY_NAME.has(toolName)) return "mcp_write";
  const op = inferOperation(toolName);
  if (op === "write" || op === "delete") return "mcp_write";
  return "mcp_read";
}

/**
 * @param {object|null} identity
 * @param {string|null} scope
 * @returns {boolean}
 */
export function principalHasScope(identity, scope) {
  if (!scope) return true;
  return (identity?.scopes ?? []).includes(scope);
}

/**
 * Site names this principal may address. Unknown names in a grant are dropped.
 *
 * @param {object|null} identity
 * @param {string[]} configuredNames
 * @param {object|null} [grants] `auth.grants` map; `undefined` reads config.
 * @returns {string[]}
 */
export function resolveGrantedSiteNames(identity, configuredNames, grants) {
  if (!identity) return [...configuredNames];
  const known = new Set(configuredNames);
  const grantMap = grants === undefined ? getInboundGrants() : grants;

  if (grantMap) {
    const listed = identity.clientId
      ? new Map(Object.entries(grantMap)).get(identity.clientId)
      : undefined;
    if (!Array.isArray(listed)) return [];
    return listed.map(String).filter((name) => known.has(name));
  }

  if (Array.isArray(identity.sites)) {
    return identity.sites.map(String).filter((name) => known.has(name));
  }

  return [...configuredNames];
}

/**
 * @param {object|null} identity
 * @param {Array<{_name: string}>} sites
 * @param {object|null} [grants]
 * @returns {Array<object>}
 */
export function resolveGrantedSites(identity, sites, grants) {
  const allowed = new Set(
    resolveGrantedSiteNames(identity, sites.map((site) => site._name), grants),
  );
  return sites.filter((site) => allowed.has(site._name));
}

/**
 * @param {object} site
 * @param {string} toolName
 * @returns {boolean}
 */
function siteAllowsTool(site, toolName) {
  const sec = resolveSecurityConfig(site);
  if (toolName === "drupal_graphql" || toolName === "drupal_graphql_introspect") {
    return Boolean(sec.allowGraphql);
  }
  if (toolName === "drupal_drush_sql_query") {
    return site.drushSsh?.rawSql === "governed";
  }
  if (toolName === "drupal_config_set") {
    return Boolean(sec.allowConfigWrite) && !sec.readOnly;
  }
  if (toolName === "drupal_config_get" || toolName === "drupal_config_list") {
    return Boolean(sec.allowConfigRead);
  }
  const op = inferOperation(toolName);
  const writeLike = op === "write" || op === "delete" || WRITE_BY_NAME.has(toolName);
  if (writeLike && sec.readOnly) return false;
  if ((op === "delete" || toolName === "drupal_entity_delete") && !sec.allowDestructive) {
    return false;
  }
  return true;
}

/**
 * @param {string} toolName
 * @param {object|null} identity
 * @param {Array<object>} sites
 * @param {object|null} [grants]
 * @returns {boolean}
 */
export function principalMayUseTool(toolName, identity, sites, grants) {
  if (!identity) return true;
  if (DIAGNOSTIC_TOOLS.has(toolName)) return true;
  if (!principalHasScope(identity, requiredScopeForTool(toolName))) return false;
  const entitled = resolveGrantedSites(identity, sites, grants);
  if (!entitled.length) return false;
  if (FREE_FORM_TOOLS.has(toolName)) {
    return entitled.some((site) => siteAllowsTool(site, toolName));
  }
  return entitled.some((site) => siteAllowsTool(site, toolName));
}

/**
 * @param {Array<{name: string}>} definitions
 * @param {Array<object>} sites
 * @param {object|null} identity
 * @param {object|null} [grants]
 * @returns {Array<object>}
 */
export function filterToolsByPrincipal(definitions, sites, identity, grants) {
  if (!identity) return definitions;
  return definitions.filter((definition) =>
    principalMayUseTool(definition.name, identity, sites, grants));
}

/**
 * @param {object} [args]
 * @returns {Array<{key: string, value: string}>}
 */
export function callerTargetHints(args = {}) {
  const found = [];
  for (const key of TARGET_HINT_KEYS) {
    const value = new Map(Object.entries(args ?? {})).get(key);
    if (typeof value === "string" && value.trim()) {
      found.push({ key, value: value.trim() });
    }
  }
  return found;
}

/**
 * @param {object} site
 * @param {string} source
 * @returns {{name: string, baseUrl?: string, source: string}}
 */
export function describeTarget(site, source) {
  return {
    name: site._name,
    baseUrl: site.baseUrl,
    source,
  };
}

/**
 * Resolve the site this principal may use for a call.
 *
 * @param {object} args
 * @param {object} identity
 * @param {Array<object>} sites
 * @param {{grants?: object|null, defaultSite?: string}} [options]
 * @returns {{site: object, source: string, name: string}}
 * @throws {SecurityError}
 */
export function resolveAuthoritativeTarget(args, identity, sites, options = {}) {
  const grantMap = options.grants === undefined ? getInboundGrants() : options.grants;
  const entitled = resolveGrantedSites(identity, sites, grantMap);
  const hints = callerTargetHints(args);
  const unique = [...new Set(hints.map((hint) => hint.value))];

  if (unique.length > 1) {
    throw new SecurityError(
      "Conflicting caller target hints do not select a single granted target.",
    );
  }

  if (unique.length === 1) {
    const site = entitled.find((entry) => entry._name === unique[0]);
    if (!site) {
      throw new SecurityError("Not entitled to the requested target.");
    }
    return { site, source: "hint", name: site._name };
  }

  const defaultName = options.defaultSite ?? getDefaultSiteName();
  const fromDefault = entitled.find((entry) => entry._name === defaultName);
  if (fromDefault) {
    return { site: fromDefault, source: "default", name: fromDefault._name };
  }
  if (entitled.length === 1) {
    return { site: entitled[0], source: "grant", name: entitled[0]._name };
  }

  throw new SecurityError(
    entitled.length
      ? "No authoritative target could be resolved from the principal grant."
      : "Principal is not entitled to any configured target.",
  );
}

/**
 * Deny unauthorized invocation. Returns the resolved target, or null for
 * tools that do not address a site.
 *
 * @param {object} params
 * @returns {{site: object, source: string, name: string}|null}
 * @throws {SecurityError}
 */
export function assertPrincipalEntitlement({
  toolName,
  args,
  identity,
  sites,
  grants,
  defaultSite,
}) {
  if (!identity) return null;
  if (!principalMayUseTool(toolName, identity, sites, grants)) {
    throw new SecurityError(`Not entitled to invoke ${toolName}.`);
  }
  if (toolName === "drupal_list_sites") return null;
  return resolveAuthoritativeTarget(args, identity, sites, { grants, defaultSite });
}

/**
 * @param {Array<object>} resources
 * @param {object|null} identity
 * @param {Array<object>} sites
 * @param {object|null} [grants]
 * @returns {Array<object>}
 */
export function filterResourcesByPrincipal(resources, identity, sites, grants) {
  if (!identity) return resources;
  const entitled = resolveGrantedSites(identity, sites, grants);
  const canRead = principalHasScope(identity, "mcp_read") && entitled.length > 0;
  return resources.filter((resource) => {
    if (resource.uri === "drupal://sites") return true;
    return canRead;
  });
}

/**
 * @param {Array<object>} prompts
 * @param {object|null} identity
 * @param {Array<{name: string}>} visibleTools
 * @returns {Array<object>}
 */
export function filterPromptsByPrincipal(prompts, identity, visibleTools) {
  if (!identity) return prompts;
  const visible = new Set((visibleTools ?? []).map((tool) => tool.name));
  return prompts.filter((prompt) => {
    if (WRITE_WORKFLOW_PROMPTS.has(prompt.name)) {
      return principalHasScope(identity, "mcp_write");
    }
    if (READ_WORKFLOW_PROMPTS.has(prompt.name)) {
      return principalHasScope(identity, "mcp_read");
    }
    const toolName = prompt.name.replace(/-/g, "_");
    return visible.has(toolName);
  });
}
