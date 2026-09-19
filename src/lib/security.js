import { parse } from "graphql";

/**
 * Security layer — connector-level access control.
 *
 * This is a SECOND layer of defense on top of Drupal's own permission system.
 * It lets you restrict what the MCP server will even attempt, regardless of
 * what the API credential is capable of doing.
 *
 * Configuration lives in config.json under each site's "security" key.
 * See config/config.example.json for annotated examples.
 *
 * ─── Quick presets ────────────────────────────────────────────────────────
 *
 *   "preset": "development"        Everything allowed. Opt-in only — set explicitly.
 *   "preset": "content-editor"     Create/edit content (nodes, media, terms, paragraphs, blocks,
 *                                  menu links, redirects, aliases, files). No deletes. Config read-only.
 *   "preset": "config-editor"      content-editor + site-building config READ + governed config
 *                                  read/write (Developer tier). Model changes go via the config bridge.
 *   "preset": "auditor"            Read-only. Sensitive entity types denied. User fields redacted.
 *   "preset": "production-strict"  Read-only. Sensitive types denied. Redacts PII. **Default** when
 *                                  security is omitted or has no preset (#140).
 *   "preset": "write-plane"        Governed writes (no delete/mutations) on the content set
 *                                  (node, term, media + structural content entities).
 *
 * Secrets, the agent's own governance config, and account data (see SENSITIVE_DENY)
 * are always denied on the content/developer tiers, regardless of the allowlist.
 *
 * Presets can be overridden by adding explicit keys alongside them.
 *
 * ─── Explicit config keys ─────────────────────────────────────────────────
 *
 *  readOnly            true  → reject all create/update/delete/graphql-mutation calls
 *  allowDestructive    false → reject all delete operations
 *  allowPublish        false → reject a write carrying status:true / moderation_state:published
 *  allowGraphql        false → reject drupal_graphql + introspect (raw GraphQL is policy-free, #142)
 *  allowGraphqlMutations false → reject drupal_graphql when mutation is detected
 *  allowConfigRead     false → reject drupal_config_get / drupal_config_list
 *  allowConfigWrite    false → reject drupal_config_set
 *
 *  Config caps mirror the server-side governance profile (allow_config_read /
 *  allow_config_write). Drupal stays authoritative; this is defence in depth.
 *
 *  allowedEntityTypes  string[] | null   null = allow all; array = allowlist
 *  deniedEntityTypes   string[]          always-blocked entity types
 *
 *  entityRules         object            per-entity-type overrides:
 *    [entityType]:
 *      allowedOperations   ["read","create","update","delete"]  (or subset)
 *      allowedBundles      string[] | null
 *      deniedBundles       string[]
 *      redactedFields      string[]      stripped from ALL responses for this type
 *
 *  globalRedactedFields string[]         stripped from every response, every type
 *
 *  protectedModules    string[]          module machine names ADDED to the default
 *                                        protected list (DEFAULT_PROTECTED_MODULES).
 *                                        drupal_drush_module_disable refuses them (#346).
 *  allowProtectedModuleUninstall string[] explicit opt-out: names REMOVED from the
 *                                        protected list. The only way to shrink it.
 *                                        A malformed value in either key refuses
 *                                        every uninstall rather than being ignored.
 *  allowCoreExtensionChange boolean      false on every preset. true lets
 *                                        drupal_config_set write core.extension and
 *                                        lets drupal_drush_config_import run when
 *                                        core.extension differs (#349). Anything but
 *                                        true or false keeps both refused.
 *
 *  declaredCeiling     string            narrow-only X-MCP-Declared-Ceiling
 *                                        (public|internal|restricted). Invalid
 *                                        values are dropped, never widened.
 *  readBudgets         object            finite northbound budgets bound to
 *                                        principal+target (#179). Same classes
 *                                        as mcp_sentinel: results, bytes,
 *                                        requests, requestWindowSec, pages,
 *                                        pageWindowSec, chainedActions,
 *                                        chainedActionWindowSec. Omitted keys
 *                                        use the module defaults.
 *
 * ─── Field redaction ──────────────────────────────────────────────────────
 *
 *  Redacted fields are replaced with "[REDACTED]" in response attributes.
 *  Recommended to include for user entities: "pass", "mail" (if PII concern).
 *  The connector never writes these fields either when redaction is active.
 */

// ---------------------------------------------------------------------------
// Shared entity-type groups
// ---------------------------------------------------------------------------
//
// The connector allowlist is deliberately safe-by-default: the Drupal site
// exposes secret-, governance-, and PII-bearing entity types over JSON:API
// (oauth2_token, key, consumer, mcp_tool_config, profile, webform_submission,
// …), so anything not explicitly listed stays denied. Widen these groups to
// grant capability; never flip a content/developer tier to allowedEntityTypes:
// null.

// Content (fieldable) entities used to build and manage page content. All are
// JSON:API-writable, so the standard entity tools create/update them directly.
const CONTENT_STRUCTURAL = [
  "paragraph",
  "block_content",
  "menu_link_content",
  "redirect",
  "path_alias",
  "file",
];

// Content-model *config* entities. Allowlisted for READ / introspection only —
// they are config entities, so building/changing them goes through the governed
// config bridge (config_set → mcp_sentinel) or `drush config:import`, NOT
// drupal_entity_create. Granted to the developer tier only.
const SITE_BUILDER_CONFIG = [
  "node_type",
  "paragraphs_type",
  "block_content_type",
  "media_type",
  "field_config",
  "field_storage_config",
  "entity_form_display",
  "entity_view_display",
  "taxonomy_vocabulary",
];

// Always-blocked: secrets, the agent's own governance config, and account data.
// Belt-and-suspenders denylist — these stay blocked even if a future change
// widens an allowlist. (deniedEntityTypes takes priority over allowedEntityTypes.)
const SENSITIVE_DENY = [
  "user",
  "oauth2_token",
  "key",
  "consumer",
  "encryption_profile",
  "mcp_tool_config",
  "mcp_policy_profile",
];

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

const PRESETS = {
  development: {
    readOnly: false,
    allowDestructive: true,
    allowPublish: true,               // mirrors allowDestructive: everything allowed
    allowGraphql: true,               // raw GraphQL allowed only in open mode (#142)
    allowGraphqlMutations: true,
    allowConfigRead: true,
    allowConfigWrite: true,
    allowedEntityTypes: null,
    deniedEntityTypes: [],
    entityRules: {},
    globalRedactedFields: [],
  },

  "content-editor": {
    readOnly: false,
    allowDestructive: false,          // no deletes
    allowGraphql: false,              // freeform GraphQL bypasses entity denylists (#142)
    allowGraphqlMutations: false,
    allowConfigRead: true,            // config read-only
    allowConfigWrite: false,
    // Full content building: base content types + structural content entities
    // (paragraphs, custom blocks, menu links, redirects, aliases, files).
    allowedEntityTypes: ["node", "media", "taxonomy_term", ...CONTENT_STRUCTURAL],
    deniedEntityTypes: [...SENSITIVE_DENY],
    entityRules: {
      node:          { allowedOperations: ["read", "create", "update"] },
      media:         { allowedOperations: ["read", "create", "update"] },
      file:          { allowedOperations: ["read", "create"] },
      taxonomy_term: { allowedOperations: ["read", "create", "update"] },
    },
    globalRedactedFields: [],
  },

  "config-editor": {
    // Developer tier: content-editor capabilities PLUS governed config read/write.
    // The Drupal-side governance layer remains authoritative; this is defence in depth.
    readOnly: false,
    allowDestructive: false,          // no deletes
    allowGraphql: false,
    allowGraphqlMutations: false,
    allowConfigRead: true,
    allowConfigWrite: true,           // governed config writes via drupal_config_set
    // content-editor's content set PLUS site-building config entities, the
    // latter for READ / introspection only — model changes go through the
    // governed config bridge (drupal_config_set) / drush config:import.
    allowedEntityTypes: ["node", "media", "taxonomy_term", ...CONTENT_STRUCTURAL, ...SITE_BUILDER_CONFIG],
    deniedEntityTypes: [...SENSITIVE_DENY],
    entityRules: {
      node:          { allowedOperations: ["read", "create", "update"] },
      media:         { allowedOperations: ["read", "create", "update"] },
      file:          { allowedOperations: ["read", "create"] },
      taxonomy_term: { allowedOperations: ["read", "create", "update"] },
    },
    globalRedactedFields: [],
  },

  auditor: {
    readOnly: true,
    allowDestructive: false,
    allowGraphql: false,
    allowGraphqlMutations: false,
    allowConfigRead: true,            // read-only inspection of config
    allowConfigWrite: false,
    allowedEntityTypes: null,         // read any entity type
    // Secrets / governance / account entities stay denied even on broad read (#140).
    deniedEntityTypes: [...SENSITIVE_DENY],
    entityRules: {
      user: {
        allowedOperations: ["read"],
        redactedFields: ["pass", "mail"],
      },
    },
    globalRedactedFields: [],
  },

  "production-strict": {
    readOnly: true,
    allowDestructive: false,
    allowGraphql: false,
    allowGraphqlMutations: false,
    allowConfigRead: false,           // nothing implicit; opt in per site
    allowConfigWrite: false,
    allowedEntityTypes: null,         // set an explicit allowlist in your config
    deniedEntityTypes: [...SENSITIVE_DENY], // includes user + secrets/governance
    entityRules: {},
    globalRedactedFields: ["pass", "mail", "field_private", "field_api_key", "field_token"],
  },

  "write-plane": {
    // Mirrors the server-side governance profile for agent writes. The
    // Drupal-side governance layer remains authoritative; this is defence in depth.
    readOnly: false,
    allowDestructive: false,          // no deletes
    allowGraphql: false,              // JSON:API write plane; GraphQL is policy-free (#142)
    allowGraphqlMutations: false,     // writes go through the JSON:API plane
    allowConfigRead: true,            // config read-only
    allowConfigWrite: false,
    // Full content building on the content tier: base content + structural
    // content entities. No site-building config entities (developer tier only).
    allowedEntityTypes: ["node", "taxonomy_term", "media", ...CONTENT_STRUCTURAL],
    deniedEntityTypes: [...SENSITIVE_DENY],
    entityRules: {},
    globalRedactedFields: ["pass", "mail"],
  },
};

// ---------------------------------------------------------------------------
// Resolve effective security config for a site
// ---------------------------------------------------------------------------

/**
 * Resolve a site's effective security config by layering explicit `security`
 * keys over the selected preset (explicit keys win; redacted-field lists merge).
 * @param {object} site Site config (reads site.security).
 * @returns {object} Effective security config used by the assert/redact helpers.
 */
/**
 * Modules drupal_drush_module_disable refuses to uninstall, on every preset
 * (#346). Uninstalling one removes a control the connector relies on, and
 * Drupal drops the module's hook_schema tables on uninstall, so an audit log or
 * stored keys go with it. Operators extend the list with
 * `security.protectedModules` and shrink it only with the explicit
 * `security.allowProtectedModuleUninstall`.
 */
export const DEFAULT_PROTECTED_MODULES = Object.freeze([
  // Governance and integrity.
  "mcp_sentinel", "audit_chain", "field_guard", "file_gate",
  // Secrets and authentication.
  "key", "encrypt", "simple_oauth", "consumers",
  // The API and governed tool surface the connector talks to.
  "jsonapi", "serialization", "mcp_server", "mcp_server_tool_bridge", "tool",
  // The editorial gate that decides publication.
  "content_moderation", "workflows",
]);

/** Drupal module machine name. Same rule as validateMachineName(), kept local to avoid an import cycle. */
const MODULE_NAME_RE = /^[a-z][a-z0-9_]{0,127}$/;

/**
 * Read one module-list key from raw site security config.
 * @param {object} raw site.security.
 * @param {string} key Config key.
 * @param {string[]} problems Collects a message per malformed key.
 * @returns {string[]} The valid names (empty when the key is absent or malformed).
 */
function readModuleList(raw, key, problems) {
  const value = new Map(Object.entries(raw)).get(key);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(`security.${key} must be an array of module machine names.`);
    return [];
  }
  const valid = value.filter((name) => typeof name === "string" && MODULE_NAME_RE.test(name));
  if (valid.length !== value.length) {
    problems.push(
      `security.${key} has ${value.length - valid.length} entr${value.length - valid.length === 1 ? "y that is" : "ies that are"} ` +
      "not a module machine name (lowercase letters, digits and underscores)."
    );
    // A malformed opt-out never removes anything; a malformed extension still adds its valid names.
    return key === "allowProtectedModuleUninstall" ? [] : valid;
  }
  return valid;
}

/**
 * Resolve the effective protected-module list for a site.
 * @param {object} raw site.security.
 * @returns {{modules: string[], optOuts: string[], error: ?string}} `error` is
 *   set when either key is malformed; callers must then refuse every uninstall.
 */
function resolveProtectedModules(raw) {
  const problems = [];
  const added = readModuleList(raw, "protectedModules", problems);
  const optOuts = readModuleList(raw, "allowProtectedModuleUninstall", problems);
  const removed = new Set(optOuts);
  const modules = [...new Set([...DEFAULT_PROTECTED_MODULES, ...added])].filter((name) => !removed.has(name)).sort();
  return { modules, optOuts: [...removed].sort(), error: problems.length ? problems.join(" ") : null };
}

/** The config object that lists installed modules and themes. */
export const CORE_EXTENSION_CONFIG = "core.extension";

/**
 * Whether a config name addresses core.extension. Surrounding space and case
 * are ignored: a source that trims the name would otherwise be reached by a
 * padded one.
 * @param {*} name Config object name.
 * @returns {boolean}
 */
export function isCoreExtensionConfig(name) {
  return typeof name === "string" && name.trim().toLowerCase() === CORE_EXTENSION_CONFIG;
}

/**
 * Resolve the explicit opt-in for changing core.extension (#349).
 * @param {object} raw site.security.
 * @returns {{allowed: boolean, error: ?string}} `error` is set when the value
 *   is neither true nor false; the change then stays refused.
 */
function resolveCoreExtensionOptIn(raw) {
  const value = new Map(Object.entries(raw)).get("allowCoreExtensionChange");
  if (value === undefined || value === null) return { allowed: false, error: null };
  if (typeof value !== "boolean") {
    return { allowed: false, error: "security.allowCoreExtensionChange must be true or false." };
  }
  return { allowed: value, error: null };
}

/** Default when `security.preset` is omitted — least privilege, not open mode (#140). */
export const DEFAULT_SECURITY_PRESET = "production-strict";

export function resolveSecurityConfig(site) {
  const raw = site.security ?? {};
  // Explicit preset wins; bare {} / missing security → production-strict (#140).
  // Open mode requires `preset: "development"` (or another named preset).
  const presetName = raw.preset ?? DEFAULT_SECURITY_PRESET;
  const preset = PRESETS[presetName] ?? PRESETS[DEFAULT_SECURITY_PRESET];

  const protectedModules = resolveProtectedModules(raw);
  const coreExtension = resolveCoreExtensionOptIn(raw);

  // Merge: explicit keys in site.security override the preset
  return {
    readOnly:              raw.readOnly              ?? preset.readOnly,
    allowDestructive:      raw.allowDestructive      ?? preset.allowDestructive,
    allowPublish:          raw.allowPublish          ?? preset.allowPublish          ?? false,
    allowGraphql:          raw.allowGraphql          ?? preset.allowGraphql          ?? false,
    allowGraphqlMutations: raw.allowGraphqlMutations ?? preset.allowGraphqlMutations,
    allowConfigRead:       raw.allowConfigRead       ?? preset.allowConfigRead       ?? false,
    allowConfigWrite:      raw.allowConfigWrite      ?? preset.allowConfigWrite      ?? false,
    allowedEntityTypes:    raw.allowedEntityTypes    ?? preset.allowedEntityTypes,
    deniedEntityTypes:     raw.deniedEntityTypes     ?? preset.deniedEntityTypes,
    entityRules:           mergeEntityRules(preset.entityRules, raw.entityRules ?? {}),
    globalRedactedFields:  [
      ...(preset.globalRedactedFields ?? []),
      ...(raw.globalRedactedFields    ?? []),
    ],
    declaredCeiling:       raw.declaredCeiling ?? preset.declaredCeiling,
    readBudgets:           raw.readBudgets ?? preset.readBudgets ?? null,
    // Not a preset value: the default list applies on every preset (#346).
    protectedModules:        protectedModules.modules,
    protectedModuleOptOuts:  protectedModules.optOuts,
    protectedModulesError:   protectedModules.error,
    // Not a preset value either: strict on every preset (#349).
    allowCoreExtensionChange: coreExtension.allowed,
    coreExtensionChangeError: coreExtension.error,
  };
}

/**
 * Shallow-merge per-entity-type rule objects, with override rules taking
 * priority over preset rules for each entity type.
 * @param {object} base Preset entityRules.
 * @param {object} override Site-supplied entityRules.
 * @returns {object} Merged entityRules.
 */
function mergeEntityRules(base, override) {
  const entries = Object.entries(override).map(([entityType, rules]) => {
    const baseRules = new Map(Object.entries(base)).get(entityType) ?? {};
    return [entityType, { ...baseRules, ...rules }];
  });
  return { ...base, ...Object.fromEntries(entries) };
}

// ---------------------------------------------------------------------------
// SecurityError
// ---------------------------------------------------------------------------

/** Error thrown when a connector-level security policy blocks an operation. */
export class SecurityError extends Error {
  /** @param {string} message Human-readable reason the operation was blocked. */
  constructor(message) {
    super(message);
    this.name = "SecurityError";
  }
}

// ---------------------------------------------------------------------------
// Assertion helpers — throw SecurityError if a check fails
// ---------------------------------------------------------------------------

/**
 * @param {object} secConfig Resolved security config.
 * @param {string} operationLabel Label used in the error message.
 * @returns {void}
 * @throws {SecurityError} if the site is configured read-only.
 */
export function assertNotReadOnly(secConfig, operationLabel) {
  if (secConfig.readOnly) {
    throw new SecurityError(
      `This site is configured as read-only. Operation blocked: ${operationLabel}. ` +
      "To enable writes, set security.readOnly = false in your config."
    );
  }
}

/**
 * Gate config reads (drupal_config_get / drupal_config_list).
 * @param {object} secConfig Resolved security config.
 * @returns {void}
 * @throws {SecurityError} if config reads are disabled for this site.
 */
export function assertConfigReadAllowed(secConfig) {
  if (!secConfig.allowConfigRead) {
    throw new SecurityError(
      "Config reads are disabled for this site. " +
      "To enable, use a preset with config access (e.g. config-editor) " +
      "or set security.allowConfigRead = true in your config."
    );
  }
}

/**
 * Gate config writes (drupal_config_set). Server-side governance remains
 * authoritative; this is the connector-side defence-in-depth layer.
 * @param {object} secConfig Resolved security config.
 * @returns {void}
 * @throws {SecurityError} if config writes are disabled for this site.
 */
export function assertConfigWriteAllowed(secConfig) {
  if (!secConfig.allowConfigWrite) {
    throw new SecurityError(
      "Config writes are disabled for this site. " +
      "To enable, use the config-editor preset (Developer tier) " +
      "or set security.allowConfigWrite = true in your config."
    );
  }
}

/**
 * Whether the site's OAuth token carries a given scope. A governed setup that
 * names no scopes carries none of them (#180) — an unnamed grant is not a
 * wildcard. A preset-only, non-OAuth site keeps the permissive behaviour.
 * @param {object} site Resolved site config.
 * @param {string} scope OAuth scope machine id (e.g. "mcp_config").
 * @returns {boolean} True if the scope is present, or no scopes are configured.
 */
export function hasScope(site, scope) {
  const scopes = site?.oauth?.scopes ?? [];
  if (scopes.length > 0) return scopes.includes(scope);
  // Empty or absent scopes. For a GOVERNED product setup — a site that claims
  // source governance, or configures OAuth at all — that is not "every scope";
  // it is an unnamed grant, and treating it as a wildcard was a bypass of the
  // very gate the scopes exist to be (#180). Deny, so the operator has to name
  // the scopes the token actually carries.
  //
  // An ungoverned install (a plain apiToken or anonymous site, no OAuth block)
  // has no scope vocabulary to name and keeps the historical permissive
  // behaviour: preset semantics alone decide there.
  return !isGovernedSetup(site);
}

/**
 * Whether a site is part of the governed product path.
 *
 * Either it declares the source-governance requirement, or it authenticates
 * with OAuth — both mean the server is deciding on scopes, so the connector
 * must not invent one.
 * @param {object} site Resolved site config.
 * @returns {boolean}
 */
function isGovernedSetup(site) {
  return site?.requireGovernance === true || Boolean(site?.oauth);
}

/**
 * Gate the config tools (get/list/set) on the dedicated `mcp_config` OAuth
 * scope, which the governed server requires for every config_* tool. When OAuth
 * scopes are configured but `mcp_config` is absent, fail fast with a clear
 * message instead of dispatching a call the server will deny — keeping the
 * connector's behaviour and its drupal_mcp_whoami report consistent with what
 * the token can actually exercise.
 * @param {object} site Resolved site config.
 * @param {string} operationLabel Label used in the error message.
 * @returns {void}
 * @throws {SecurityError} if scopes are configured and `mcp_config` is missing.
 */
export function assertConfigScope(site, operationLabel) {
  if (!hasScope(site, "mcp_config")) {
    throw new SecurityError(
      "Config tools require the 'mcp_config' OAuth scope (config-editor / " +
      "Developer tier); this token does not carry it. " +
      `Operation blocked: ${operationLabel}.`
    );
  }
}

/**
 * @param {object} secConfig Resolved security config.
 * @param {string} entityType Entity type targeted by the delete.
 * @param {string} id Entity id targeted by the delete.
 * @returns {void}
 * @throws {SecurityError} if destructive (delete) operations are disabled.
 */
export function assertDestructiveAllowed(secConfig, entityType, id) {
  if (!secConfig.allowDestructive) {
    throw new SecurityError(
      "Destructive operations (delete) are disabled for this site. " +
      `Blocked: delete ${entityType} ${id}. ` +
      "To enable, set security.allowDestructive = true in your config."
    );
  }
}

/**
 * Gate a module uninstall (drupal_drush_module_disable) against the site's
 * protected-module list (#346). Fails closed: a security config that is
 * malformed, or that never went through resolveSecurityConfig(), refuses every
 * uninstall.
 * @param {object} secConfig Resolved security config.
 * @param {string} moduleName Module machine name, already validated.
 * @returns {void}
 * @throws {SecurityError} if the module is protected or the list cannot be trusted.
 */
export function assertModuleUninstallAllowed(secConfig, moduleName) {
  if (secConfig?.protectedModulesError || !Array.isArray(secConfig?.protectedModules)) {
    throw new SecurityError(
      "Module uninstall is blocked because this site's protected-module config cannot be read. " +
      `${secConfig?.protectedModulesError ?? "The protected-module list is missing."} ` +
      "No module can be uninstalled through the connector until an operator fixes it."
    );
  }
  if (secConfig.protectedModules.includes(moduleName)) {
    throw new SecurityError(
      `Module "${moduleName}" is protected and cannot be uninstalled through the connector. ` +
      "Uninstalling it removes a control the connector relies on, and Drupal drops the module's tables on uninstall. " +
      `To allow it, an operator must add "${moduleName}" to security.allowProtectedModuleUninstall for this site.`
    );
  }
}

/**
 * Gate a change to core.extension (#349). The object lists installed modules
 * and themes, so a write to it, or a config import that changes it, can
 * uninstall a protected module without going through
 * assertModuleUninstallAllowed(). Refused on every preset unless the operator
 * set `security.allowCoreExtensionChange: true`. Fails closed: a malformed
 * value, or a config that never went through resolveSecurityConfig(), refuses.
 * @param {object} secConfig Resolved security config.
 * @param {string} refusal What is being refused and why, as full sentences.
 * @returns {void}
 * @throws {SecurityError} unless the operator opted in.
 */
export function assertCoreExtensionChangeAllowed(secConfig, refusal) {
  if (secConfig?.allowCoreExtensionChange === true && !secConfig.coreExtensionChangeError) return;
  throw new SecurityError(
    `${refusal} ` +
    "To install or uninstall a module use drupal_drush_module_enable or drupal_drush_module_disable, " +
    "which check the protected-module list. " +
    (secConfig?.coreExtensionChangeError
      ? `This site's opt-in cannot be read: ${secConfig.coreExtensionChangeError} It stays refused until an operator fixes it.`
      : "To allow it, an operator must set security.allowCoreExtensionChange = true for this site.")
  );
}

/**
 * Check a drupal_config_set value for core.extension against the protected
 * module list (#349). Runs only after assertCoreExtensionChangeAllowed().
 *
 * The value is a map of top-level keys, and the source also accepts a dotted
 * key such as `module.devel`. A `module` key replaces the whole module map, so
 * every protected module in `currentModules` must still be in it. A dotted key
 * under `module.` that names a protected module is refused outright.
 *
 * @param {object} secConfig Resolved security config.
 * @param {object} value The submitted map of config keys to values.
 * @param {?string[]} currentModules Machine names installed now, or null when
 *   the caller has not read them. Needed only when `value` has a `module` key.
 * @returns {{needsCurrentModules: boolean}} `needsCurrentModules` is true when
 *   the value replaces the module map and `currentModules` was not given; the
 *   caller reads the list and calls again.
 * @throws {SecurityError} if the write would remove or alter a protected
 *   module, or the protected-module list cannot be trusted.
 */
export function assertCoreExtensionValueKeepsProtected(secConfig, value, currentModules = null) {
  if (secConfig?.protectedModulesError || !Array.isArray(secConfig?.protectedModules)) {
    throw new SecurityError(
      "The write to core.extension is blocked because this site's protected-module config cannot be read. " +
      `${secConfig?.protectedModulesError ?? "The protected-module list is missing."}`
    );
  }
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
  const protectedSet = new Set(secConfig.protectedModules);

  const dotted = entries
    .map(([key]) => /^module\.([^.]+)/.exec(key)?.[1])
    .filter((name) => name !== undefined && protectedSet.has(name));
  if (dotted.length) {
    throw new SecurityError(
      `The write to core.extension changes the entry of protected module${dotted.length === 1 ? "" : "s"} ` +
      `${[...new Set(dotted)].sort().join(", ")}. Nothing was written. ` +
      "To allow it, an operator must name the module in security.allowProtectedModuleUninstall for this site."
    );
  }

  const moduleEntry = entries.find(([key]) => key === "module");
  if (!moduleEntry) return { needsCurrentModules: false };
  const next = moduleEntry[1];
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    throw new SecurityError(
      "The write to core.extension is refused: `module` must be a map of module machine names to weights. Nothing was written."
    );
  }
  if (!Array.isArray(currentModules)) return { needsCurrentModules: true };

  const kept = new Set(Object.keys(next));
  const removed = currentModules.filter((name) => protectedSet.has(name) && !kept.has(name)).sort();
  if (removed.length) {
    throw new SecurityError(
      `The write to core.extension would remove protected module${removed.length === 1 ? "" : "s"} ${removed.join(", ")}. ` +
      "Nothing was written. " +
      "To allow it, an operator must name the module in security.allowProtectedModuleUninstall for this site."
    );
  }
  return { needsCurrentModules: false };
}

/**
 * Whether a set of write attributes carries a publish action.
 *
 * Recognized signals:
 *   - `status === true` (non-moderated publish)
 *   - `moderation_state` equal to `"published"` (case-insensitive) — the common
 *     core content_moderation publish state (#139)
 *
 * Other workflow state names are site-specific and remain server-gated.
 * @param {object} [attributes] Attribute map for the write.
 * @returns {boolean}
 */
export function isPublishBearing(attributes = {}) {
  if (attributes?.status === true) return true;
  // Common core content_moderation publish state. Site-specific publish state
  // names remain server-gated; this closes the obvious connector-layer hole (#139).
  const mod = attributes?.moderation_state;
  if (typeof mod === "string" && mod.toLowerCase() === "published") return true;
  return false;
}

/**
 * Local, fail-fast publish gate, symmetric with assertDestructiveAllowed. When
 * the connector is not permitted to publish (allowPublish false — the default in
 * every preset except `development`), a write that is publish-bearing
 * (`status: true` or `moderation_state: "published"`) is refused before the
 * round-trip, rather than being silently dropped by a moderated-bundle retry or
 * a server-side gate (see #111/#114/#139). Client-side convenience only — the
 * remote Drupal's own permissions remain the real authority.
 * @param {object} secConfig Resolved security config.
 * @param {object} [attributes] Attribute map for the write.
 * @returns {void}
 * @throws {SecurityError} if a publish-bearing write is attempted while allowPublish is false.
 */
export function assertPublishAllowed(secConfig, attributes = {}) {
  if (secConfig.allowPublish) return;
  if (isPublishBearing(attributes)) {
    throw new SecurityError(
      "Publishing is disabled for this connector (allowPublish: false). " +
      "Blocked: a write carrying status:true or moderation_state:published. " +
      "To enable, set security.allowPublish = true in your config."
    );
  }
}

/**
 * Detect whether a GraphQL document contains a mutation operation.
 * Uses a real parser (robust against multi-operation docs, comments, and
 * leading whitespace); falls back to a token-aware regex if the document
 * does not parse.
 * @param {string} query GraphQL document text.
 * @returns {boolean} True if any operation is a mutation.
 */
export function graphqlHasMutation(query) {
  try {
    const doc = parse(query);
    return doc.definitions.some(
      (d) => d.kind === "OperationDefinition" && d.operation === "mutation"
    );
  } catch {
    // Unparseable — be conservative. Whole-string, token-aware (no ^/m anchors).
    return /(^|[^A-Za-z0-9_])mutation\s+[A-Za-z_{]/.test(query);
  }
}

/**
 * @param {object} secConfig Resolved security config.
 * @param {string} query GraphQL document text.
 * @returns {void} No-op for read-only (query) documents.
 * @throws {SecurityError} if the document is a mutation and writes/mutations are disabled.
 */
/**
 * Gate GraphQL queries and schema introspection. Freeform GraphQL returns raw
 * data that does not pass through entity allowlists or field redaction (#142),
 * so it is off by default outside the development preset. Opt in with
 * `security.allowGraphql: true`.
 *
 * @param {object} secConfig Resolved security config.
 * @param {string} [operationLabel] Label for the error message.
 * @returns {void}
 * @throws {SecurityError} if GraphQL is disabled for this site.
 */
export function assertGraphqlAllowed(secConfig, operationLabel = "graphql") {
  if (secConfig.allowGraphql) return;
  throw new SecurityError(
    "GraphQL tools are disabled for this site (allowGraphql: false). " +
    "Raw GraphQL responses bypass connector entity allowlists and field redaction. " +
    `Blocked: ${operationLabel}. ` +
    "Set security.allowGraphql = true to enable (prefer development preset or an explicit opt-in)."
  );
}

export function assertGraphqlMutationAllowed(secConfig, query) {
  // Queries still require allowGraphql (#142); mutations require both flags.
  assertGraphqlAllowed(secConfig, "graphql mutation");
  const isMutation = graphqlHasMutation(query);
  if (!isMutation) return;

  // A read-only site blocks GraphQL mutations with the same switch as JSON:API writes.
  if (secConfig.readOnly) {
    assertNotReadOnly(secConfig, "graphql mutation");
  }
  if (!secConfig.allowGraphqlMutations) {
    throw new SecurityError(
      "GraphQL mutations are disabled for this site. " +
      "Set security.allowGraphqlMutations = true to enable."
    );
  }
}

/**
 * @param {object} secConfig Resolved security config.
 * @param {string} entityType Entity type to check.
 * @returns {void}
 * @throws {SecurityError} if the type is denied, or not in a configured allowlist.
 */
export function assertEntityTypeAllowed(secConfig, entityType) {
  // Check denylist first (takes priority over allowlist)
  if (secConfig.deniedEntityTypes.includes(entityType)) {
    throw new SecurityError(
      `Access to entity type "${entityType}" is denied by security config (deniedEntityTypes).`
    );
  }

  // Check allowlist
  if (secConfig.allowedEntityTypes !== null) {
    if (!secConfig.allowedEntityTypes.includes(entityType)) {
      const allowed = secConfig.allowedEntityTypes.join(", ");
      throw new SecurityError(
        `Entity type "${entityType}" is not in the allowedEntityTypes list. ` +
        `Allowed: ${allowed}`
      );
    }
  }
}

/**
 * @param {object} secConfig Resolved security config.
 * @param {string} entityType Entity type owning the bundle.
 * @param {string} bundle Bundle to check.
 * @returns {void} No-op when the entity type has no bundle rules.
 * @throws {SecurityError} if the bundle is denied, or not in a configured allowlist.
 */
export function assertBundleAllowed(secConfig, entityType, bundle) {
  const rules = new Map(Object.entries(secConfig.entityRules)).get(entityType);
  if (!rules) return; // no rules = allowed

  if (rules.deniedBundles?.includes(bundle)) {
    throw new SecurityError(
      `Bundle "${bundle}" of entity type "${entityType}" is in the deniedBundles list.`
    );
  }
  if (rules.allowedBundles !== null && rules.allowedBundles !== undefined) {
    if (!rules.allowedBundles.includes(bundle)) {
      throw new SecurityError(
        `Bundle "${bundle}" is not in allowedBundles for "${entityType}". ` +
        `Allowed: ${rules.allowedBundles.join(", ")}`
      );
    }
  }
}

/**
 * @param {object} secConfig Resolved security config.
 * @param {"read"|"create"|"update"|"delete"} operation Operation to check.
 * @param {string} entityType Entity type the operation targets.
 * @returns {void} No-op when the type has no allowedOperations restriction.
 * @throws {SecurityError} if the operation is not in the type's allowedOperations.
 */
export function assertOperationAllowed(secConfig, operation, entityType) {
  const rules = new Map(Object.entries(secConfig.entityRules)).get(entityType);
  if (!rules?.allowedOperations) return; // no restriction

  if (!rules.allowedOperations.includes(operation)) {
    throw new SecurityError(
      `Operation "${operation}" is not allowed on entity type "${entityType}". ` +
      `Allowed operations: ${rules.allowedOperations.join(", ")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Composite assertion for read operations (most common)
// ---------------------------------------------------------------------------

/**
 * Composite read gate: entity type, bundle (if given), and the "read" operation.
 * @param {object} secConfig Resolved security config.
 * @param {string} entityType Entity type to read.
 * @param {string} [bundle] Bundle to read.
 * @returns {void}
 * @throws {SecurityError} if any underlying check fails.
 */
export function assertReadAllowed(secConfig, entityType, bundle) {
  assertEntityTypeAllowed(secConfig, entityType);
  if (bundle) assertBundleAllowed(secConfig, entityType, bundle);
  assertOperationAllowed(secConfig, "read", entityType);
}

/**
 * Composite write gate: read-only switch, entity type, bundle (if given), and op.
 * @param {object} secConfig Resolved security config.
 * @param {"create"|"update"|"delete"} operation Write operation.
 * @param {string} entityType Entity type to write.
 * @param {string} [bundle] Bundle to write.
 * @returns {void}
 * @throws {SecurityError} if any underlying check fails.
 */
export function assertWriteAllowed(secConfig, operation, entityType, bundle) {
  assertNotReadOnly(secConfig, `${operation} ${entityType}`);
  assertEntityTypeAllowed(secConfig, entityType);
  if (bundle) assertBundleAllowed(secConfig, entityType, bundle);
  assertOperationAllowed(secConfig, operation, entityType);
}

/**
 * Composite delete gate: destructive switch plus the full write gate.
 * @param {object} secConfig Resolved security config.
 * @param {string} entityType Entity type to delete.
 * @param {string} [bundle] Bundle to delete.
 * @param {string} id Entity id to delete (used in the error message).
 * @returns {void}
 * @throws {SecurityError} if deletes are disabled or any write check fails.
 */
export function assertDeleteAllowed(secConfig, entityType, bundle, id) {
  assertDestructiveAllowed(secConfig, entityType, id);
  assertWriteAllowed(secConfig, "delete", entityType, bundle);
}

// ---------------------------------------------------------------------------
// Field redaction
// ---------------------------------------------------------------------------

/**
 * Redact sensitive fields from a JSON:API resource object (or array of them),
 * replacing their `attributes` values with "[REDACTED]".
 * @param {?(object|object[])} resource JSON:API resource(s) to redact.
 * @param {object} secConfig Resolved security config (supplies the field lists).
 * @param {string} entityType Entity type, used to pick per-type redacted fields.
 * @returns {?(object|object[])} New resource object(s); originals are not mutated.
 */
export function redactResource(resource, secConfig, entityType) {
  if (!resource) return resource;

  // Collect fields to redact for this entity type
  const entityRules = new Map(Object.entries(secConfig.entityRules)).get(entityType) ?? {};
  const fieldsToRedact = new Set([
    ...(secConfig.globalRedactedFields ?? []),
    ...(entityRules.redactedFields      ?? []),
  ]);

  if (fieldsToRedact.size === 0) return resource;

  function redactAttrs(obj) {
    if (!obj?.attributes) return obj;
    const attrs = Object.fromEntries(
      Object.entries(obj.attributes).map(([k, v]) => [k, fieldsToRedact.has(k) ? "[REDACTED]" : v])
    );
    return { ...obj, attributes: attrs };
  }

  if (Array.isArray(resource)) return resource.map(redactAttrs);
  return redactAttrs(resource);
}

/**
 * Redact sensitive fields from a CANONICAL entity (base props + `fields`).
 * Mirrors redactResource but for the API-neutral canonical shape.
 * @param {?object} entity Canonical entity to redact.
 * @param {object} secConfig Resolved security config (supplies the field lists).
 * @param {string} entityType Entity type, used to pick per-type redacted fields.
 * @returns {?object} New entity; original is not mutated.
 */
export function redactCanonicalEntity(entity, secConfig, entityType) {
  if (!entity) return entity;
  const entityRulesMap = secConfig.entityRules ? new Map(Object.entries(secConfig.entityRules)) : new Map();
  const entityRules = entityRulesMap.get(entityType) ?? {};
  const fieldsToRedact = new Set([
    ...(secConfig.globalRedactedFields ?? []),
    ...(entityRules.redactedFields ?? []),
  ]);
  if (fieldsToRedact.size === 0) return entity;

  const redactedFields = Object.fromEntries(
    Object.entries(entity.fields ?? {}).map(([k, v]) => [k, fieldsToRedact.has(k) ? "[REDACTED]" : v])
  );
  const BASE_PROPS = ["title", "status", "langcode", "created", "changed", "url"];
  const baseOverrides = Object.fromEntries(
    BASE_PROPS.filter((p) => fieldsToRedact.has(p)).map((p) => [p, "[REDACTED]"])
  );
  return { ...entity, fields: redactedFields, ...baseOverrides };
}

// ---------------------------------------------------------------------------
// Security summary tool (exposed as drupal_security_info)
// ---------------------------------------------------------------------------

/**
 * Build a human-readable summary of a site's effective security policy
 * (exposed via the drupal_security_info tool). Lists only policy settings —
 * no credentials.
 * @param {object} site Site config.
 * @returns {object} Flat summary of the resolved security settings.
 */
export function getSecuritySummary(site) {
  const cfg = resolveSecurityConfig(site);
  return {
    site:                  site._name,
    preset:                site.security?.preset ?? `${DEFAULT_SECURITY_PRESET} (default)`,
    readOnly:              cfg.readOnly,
    allowDestructive:      cfg.allowDestructive,
    allowPublish:          cfg.allowPublish,
    allowGraphql:          cfg.allowGraphql,
    allowGraphqlMutations: cfg.allowGraphqlMutations,
    allowConfigRead:       cfg.allowConfigRead,
    allowConfigWrite:      cfg.allowConfigWrite,
    allowedEntityTypes:    cfg.allowedEntityTypes ?? "all",
    deniedEntityTypes:     cfg.deniedEntityTypes,
    entityRules:           cfg.entityRules,
    globalRedactedFields:  cfg.globalRedactedFields,
    declaredCeiling:       cfg.declaredCeiling ?? null,
    protectedModules:      cfg.protectedModules,
    protectedModuleOptOuts: cfg.protectedModuleOptOuts,
    ...(cfg.protectedModulesError ? { protectedModulesError: cfg.protectedModulesError } : {}),
    allowCoreExtensionChange: cfg.allowCoreExtensionChange,
    ...(cfg.coreExtensionChangeError ? { coreExtensionChangeError: cfg.coreExtensionChangeError } : {}),
  };
}
