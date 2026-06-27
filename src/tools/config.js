/**
 * Tool group: Governed configuration + agent identity.
 *
 * Configuration get/list/set are mediated by Drupal's authoritative governance
 * layer: each tool calls a server-side MCP tool over the bridge in
 * lib/server-tools.js (NOT drush). The connector-side security caps
 * (allowConfigRead / allowConfigWrite) are a second, defence-in-depth gate.
 *
 * drupal_mcp_whoami reports the agent's effective tier/profile/capabilities for
 * a site so the agent and a human operator can see what is permitted up front,
 * reducing surprise denials.
 */

import { getSiteConfig } from "../lib/config.js";
import {
  resolveSecurityConfig,
  getSecuritySummary,
  assertNotReadOnly,
  assertConfigReadAllowed,
  assertConfigWriteAllowed,
  assertConfigScope,
  hasScope,
} from "../lib/security.js";
import { callServerTool, SERVER_TOOLS } from "../lib/server-tools.js";

// ---------------------------------------------------------------------------
// Config tools (governed via the server-tool bridge)
// ---------------------------------------------------------------------------

/**
 * Read a single configuration object by name (e.g. "system.site").
 * @param {object} args - { site?, name }.
 * @returns {Promise<*>} The server tool's result.
 * @throws {SecurityError} if config reads are disabled for the site.
 */
async function configGet({ site: siteName, name }) {
  const site = getSiteConfig(siteName);
  assertConfigScope(site, `config:get ${name}`);
  assertConfigReadAllowed(resolveSecurityConfig(site));
  return callServerTool(site, SERVER_TOOLS.configGet, { name });
}

/**
 * List configuration object names, optionally filtered by a name prefix.
 * @param {object} args - { site?, prefix? }.
 * @returns {Promise<*>} The server tool's result.
 * @throws {SecurityError} if config reads are disabled for the site.
 */
async function configList({ site: siteName, prefix }) {
  const site = getSiteConfig(siteName);
  assertConfigScope(site, "config:list");
  assertConfigReadAllowed(resolveSecurityConfig(site));
  const args = prefix ? { prefix } : {};
  return callServerTool(site, SERVER_TOOLS.configList, args);
}

/**
 * Set a configuration value. Governed and audited server-side; the connector
 * additionally enforces the config-write cap before dispatching.
 * @param {object} args - { site?, name, value }.
 * @returns {Promise<*>} The server tool's result.
 * @throws {SecurityError} if the site is read-only or config writes are disabled.
 */
async function configSet({ site: siteName, name, value }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertConfigScope(site, `config:set ${name}`);
  assertNotReadOnly(sec, `config:set ${name}`);
  assertConfigWriteAllowed(sec);
  return callServerTool(site, SERVER_TOOLS.configSet, { name, value });
}

// ---------------------------------------------------------------------------
// Identity / capabilities
// ---------------------------------------------------------------------------

/**
 * Infer the governance tier from OAuth scopes (authoritative signal) when
 * present, else from the security preset. Mirrors the scope-keyed model in
 * the MCP agent governance design.
 * @param {object} site Resolved site config.
 * @param {object} sec Resolved security config.
 * @returns {string} One of "admin" | "developer" | "content" | "read-only".
 */
function inferTier(site, sec) {
  const scopes = site.oauth?.scopes ?? [];
  if (scopes.includes("mcp_admin"))  return "admin";
  if (scopes.includes("mcp_config")) return "developer";
  if (scopes.includes("mcp_write"))  return "content";
  if (scopes.length) return "read-only";

  // No OAuth scopes — fall back to preset semantics.
  if (sec.allowConfigWrite) return "developer";
  if (!sec.readOnly)        return "content";
  return "read-only";
}

/**
 * Report the agent's effective tier, profile, and capabilities for a site.
 * Policy only — no credentials, no backend call.
 * @param {object} args - { site? }.
 * @returns {Promise<object>} Effective identity + capability summary.
 */
async function whoami({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const summary = getSecuritySummary(site);
  // Effective capability = connector preset AND the scope the server demands.
  // Reporting the preset alone over-states what the token can do — e.g. the
  // content-editor preset allows config reads locally, but every config_* tool
  // is gated server-side on mcp_config, which the content tier does not hold.
  // When no OAuth scopes are configured, hasScope() is a no-op (preset-only).
  const canWrite  = !sec.readOnly && hasScope(site, "mcp_write");
  const canConfig = hasScope(site, "mcp_config");
  return {
    site: site._name,
    tier: inferTier(site, sec),
    preset: summary.preset,
    scopes: site.oauth?.scopes ?? [],
    api: site.api ?? "auto",
    serverToolsConfigured: Boolean(site.serverTools?.url),
    capabilities: {
      read:        hasScope(site, "mcp_read"),
      write:       canWrite,
      delete:      sec.allowDestructive && canWrite,
      configRead:  sec.allowConfigRead  && canConfig,
      configWrite: sec.allowConfigWrite && !sec.readOnly && canConfig,
      // Publishing is always gated server-side (editorial workflow); the agent
      // never holds the publish transition. Surfaced here so it is explicit.
      publish:     false,
    },
  };
}

// ---------------------------------------------------------------------------
// Definitions & handlers
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_config_get",
    description: "Read a single Drupal configuration object by name (e.g. \"system.site\") via the governed server-side config tool. Requires config read access.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: { site: { type: "string" }, name: { type: "string" } },
    },
  },
  {
    name: "drupal_config_list",
    description: "List Drupal configuration object names, optionally filtered by a name prefix, via the governed server-side config tool. Requires config read access.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" }, prefix: { type: "string" } },
    },
  },
  {
    name: "drupal_config_set",
    description: "Set a Drupal configuration value via the governed server-side config tool. Audited and gated server-side; requires the config-editor (Developer) tier. Then export to YAML for a PR.",
    inputSchema: {
      type: "object",
      required: ["name", "value"],
      properties: {
        site:  { type: "string" },
        name:  { type: "string" },
        value: { description: "The configuration value to set (object, array, or scalar)." },
      },
    },
  },
  {
    name: "drupal_mcp_whoami",
    description: "Report the agent's effective governance tier, security preset, OAuth scopes, and capabilities (read/write/delete/config/publish) for a site. No credentials, no backend call.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
    },
  },
];

export const handlers = {
  drupal_config_get:  configGet,
  drupal_config_list: configList,
  drupal_config_set:  configSet,
  drupal_mcp_whoami:  whoami,
};
