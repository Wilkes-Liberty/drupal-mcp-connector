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
import { describeTarget, getRequestIdentity } from "../lib/principal.js";
import {
  resolveSecurityConfig,
  getSecuritySummary,
  assertNotReadOnly,
  assertConfigReadAllowed,
  assertConfigWriteAllowed,
  assertConfigScope,
  assertCoreExtensionChangeAllowed,
  assertCoreExtensionValueKeepsProtected,
  isCoreExtensionConfig,
  hasScope,
  CORE_EXTENSION_CONFIG,
  SecurityError,
} from "../lib/security.js";
import { callGovernedServerTool, callBoundModuleTool, toolResultData } from "../lib/server-tools.js";

/**
 * Compatibility names use an approved module binding when configured. Without
 * bindings, the wire name comes from the source's own tools/list; a tool the
 * source does not advertise fails closed before any call.
 */
async function configTool(site, binding, args, operation, capability) {
  if (site.serverTools?.bindings !== undefined) {
    return callBoundModuleTool(site, binding, args, {
      operation, scope: "mcp_config", capabilities: [capability],
    });
  }
  return callGovernedServerTool(site, binding, args);
}

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
  return configTool(site, "configGet", { name }, "read", "configRead");
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
  return configTool(site, "configList", args, "read", "configRead");
}

/**
 * Read the machine names of the modules installed now, through the governed
 * config read. Used only to check a core.extension write (#349).
 * @param {object} site Resolved site config.
 * @param {object} sec Resolved security config.
 * @returns {Promise<string[]>} Installed module machine names.
 * @throws {SecurityError} if the list cannot be read or understood. The caller
 *   then writes nothing.
 */
async function readInstalledModules(site, sec) {
  const blocked = "The write to core.extension is refused because the current module list could not be read, " +
    "so the connector cannot tell whether a protected module would be removed. Nothing was written.";
  let data;
  try {
    assertConfigReadAllowed(sec);
    data = toolResultData(await configTool(site, "configGet", { name: CORE_EXTENSION_CONFIG }, "read", "configRead"));
  } catch (err) {
    throw new SecurityError(`${blocked} Reason: ${String(err?.message ?? err).slice(0, 300)}`);
  }
  // The source's config tool answers { name, data }; a plain config map is read too.
  const modules = [data?.data?.module, data?.module]
    .find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
  if (!modules) throw new SecurityError(`${blocked} Reason: the read returned no module map.`);
  return Object.keys(modules);
}

/**
 * Gate a drupal_config_set on core.extension (#349). A write there can install
 * or uninstall any module or theme without Drupal's install and uninstall
 * steps, and it bypasses the protected-module list. It is refused unless the
 * operator opted in; with the opt-in, a value that would remove or alter a
 * protected module is still refused.
 * @param {object} site Resolved site config.
 * @param {object} sec Resolved security config.
 * @param {object} value The submitted map of config keys to values.
 * @returns {Promise<void>}
 * @throws {SecurityError} if the write is refused.
 */
async function assertCoreExtensionWriteAllowed(site, sec, value) {
  assertCoreExtensionChangeAllowed(
    sec,
    "drupal_config_set does not write core.extension. A write there can install or uninstall any module or theme " +
    "without running Drupal's install and uninstall steps, and it bypasses the protected-module list. Nothing was written."
  );
  const { needsCurrentModules } = assertCoreExtensionValueKeepsProtected(sec, value);
  if (needsCurrentModules) {
    assertCoreExtensionValueKeepsProtected(sec, value, await readInstalledModules(site, sec));
  }
}

/**
 * Set a configuration value. Governed and audited server-side; the connector
 * additionally enforces the config-write cap before dispatching.
 *
 * The public `value` is a map of top-level config keys to their new values; the
 * server-side tool (mcp_sentinel McpConfigSetTool) takes that map under the key
 * `data` and applies a partial `$editable->set($key, $value)` per entry, so we
 * translate `value` → `data` at the call site.
 *
 * A write to `core.extension` is refused unless the operator set
 * `security.allowCoreExtensionChange` (#349). The check runs here, before the
 * binding path and the unbound path split.
 * @param {object} args - { site?, name, value }.
 * @returns {Promise<*>} The server tool's result.
 * @throws {SecurityError} if the site is read-only, config writes are disabled,
 *   or the write targets core.extension without the operator's opt-in.
 */
async function configSet({ site: siteName, name, value }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertConfigScope(site, `config:set ${name}`);
  assertNotReadOnly(sec, `config:set ${name}`);
  assertConfigWriteAllowed(sec);
  if (isCoreExtensionConfig(name)) await assertCoreExtensionWriteAllowed(site, sec, value);
  return configTool(site, "configSet", { name, data: value }, "write", "configWrite");
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
async function whoami({ site: siteName, _resolvedSource }) {
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
  const identity = getRequestIdentity();
  // Dispatch may inject `site` after a default/grant resolution. Prefer the
  // authoritative source so `target` and `_target` cannot disagree (#167).
  const source = _resolvedSource ?? (siteName ? "hint" : "default");
  return {
    site: site._name,
    target: describeTarget(site, source),
    principal: identity
      ? { sub: identity.sub, clientId: identity.clientId, scopes: [...(identity.scopes ?? [])] }
      : null,
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
      // Local publish policy (allowPublish), symmetric with delete/config caps.
      // Defaults false in every preset except `development`; the remote Drupal's
      // own permissions (and any server-side governance) remain authoritative.
      publish:     sec.allowPublish && canWrite,
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
    description: "Set a Drupal configuration value via the governed server-side config tool. Audited and gated server-side; requires the config-editor (Developer) tier. Then export to YAML for a PR. Refused for `core.extension`, which lists installed modules and themes: use drupal_drush_module_enable or drupal_drush_module_disable instead. Only an operator can allow it, with `allowCoreExtensionChange` in site config (see drupal_security_info), and a value that removes a protected module is still refused.",
    inputSchema: {
      type: "object",
      required: ["name", "value"],
      properties: {
        site:  { type: "string" },
        name:  { type: "string" },
        value: { type: "object", description: "A map of top-level config keys to their new values (e.g. { \"slogan\": \"Information Technology\" }). Other keys in the object are preserved server-side." },
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
