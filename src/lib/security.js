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
 *   "preset": "development"        Everything allowed. Default if no security key.
 *   "preset": "content-editor"     Create/edit content (nodes, media, terms, paragraphs, blocks,
 *                                  menu links, redirects, aliases, files). No deletes. Config read-only.
 *   "preset": "config-editor"      content-editor + site-building config READ + governed config
 *                                  read/write (Developer tier). Model changes go via the config bridge.
 *   "preset": "auditor"            Read-only. All entity types. User fields redacted.
 *   "preset": "production-strict"  Read-only. Explicit allowlist required. Redacts PII.
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
    allowGraphqlMutations: false,
    allowConfigRead: true,            // read-only inspection of config
    allowConfigWrite: false,
    allowedEntityTypes: null,         // read any entity type
    deniedEntityTypes: [],
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
    allowGraphqlMutations: false,
    allowConfigRead: false,           // nothing implicit; opt in per site
    allowConfigWrite: false,
    allowedEntityTypes: null,         // set an explicit allowlist in your config
    deniedEntityTypes: ["user"],      // no user data at all
    entityRules: {},
    globalRedactedFields: ["pass", "mail", "field_private", "field_api_key", "field_token"],
  },

  "write-plane": {
    // Mirrors the server-side governance profile for agent writes. The
    // Drupal-side governance layer remains authoritative; this is defence in depth.
    readOnly: false,
    allowDestructive: false,          // no deletes
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
export function resolveSecurityConfig(site) {
  const raw = site.security ?? {};
  const preset = PRESETS[raw.preset ?? "development"] ?? PRESETS.development;

  // Merge: explicit keys in site.security override the preset
  return {
    readOnly:              raw.readOnly              ?? preset.readOnly,
    allowDestructive:      raw.allowDestructive      ?? preset.allowDestructive,
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
 * Detect whether a GraphQL document contains a mutation operation.
 * Uses a real parser (robust against multi-operation docs, comments, and
 * leading whitespace); falls back to a token-aware regex if the document
 * does not parse.
 * @param {string} query GraphQL document text.
 * @returns {boolean} True if any operation is a mutation.
 */
function graphqlHasMutation(query) {
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
export function assertGraphqlMutationAllowed(secConfig, query) {
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

/**
 * Redact a full JSON:API response by redacting each item under `.data`.
 * @param {?object} response JSON:API response with a `data` object or array.
 * @param {object} secConfig Resolved security config.
 * @param {string} entityType Entity type for the response data.
 * @returns {?object} New response; original is not mutated.
 */
export function redactResponse(response, secConfig, entityType) {
  if (!response?.data) return response;
  return {
    ...response,
    data: Array.isArray(response.data)
      ? response.data.map((r) => redactResource(r, secConfig, entityType))
      : redactResource(response.data, secConfig, entityType),
  };
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
    preset:                site.security?.preset ?? "development (default)",
    readOnly:              cfg.readOnly,
    allowDestructive:      cfg.allowDestructive,
    allowGraphqlMutations: cfg.allowGraphqlMutations,
    allowConfigRead:       cfg.allowConfigRead,
    allowConfigWrite:      cfg.allowConfigWrite,
    allowedEntityTypes:    cfg.allowedEntityTypes ?? "all",
    deniedEntityTypes:     cfg.deniedEntityTypes,
    entityRules:           cfg.entityRules,
    globalRedactedFields:  cfg.globalRedactedFields,
  };
}
