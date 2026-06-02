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
 *   "preset": "content-editor"     Create/edit nodes+media. No user mgmt, no deletes.
 *   "preset": "auditor"            Read-only. All entity types. User fields redacted.
 *   "preset": "production-strict"  Read-only. Explicit allowlist required. Redacts PII.
 *
 * Presets can be overridden by adding explicit keys alongside them.
 *
 * ─── Explicit config keys ─────────────────────────────────────────────────
 *
 *  readOnly            true  → reject all create/update/delete/graphql-mutation calls
 *  allowDestructive    false → reject all delete operations
 *  allowGraphqlMutations false → reject drupal_graphql when mutation is detected
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
// Preset definitions
// ---------------------------------------------------------------------------

const PRESETS = {
  development: {
    readOnly: false,
    allowDestructive: true,
    allowGraphqlMutations: true,
    allowedEntityTypes: null,
    deniedEntityTypes: [],
    entityRules: {},
    globalRedactedFields: [],
  },

  "content-editor": {
    readOnly: false,
    allowDestructive: false,          // no deletes
    allowGraphqlMutations: false,
    allowedEntityTypes: ["node", "media", "file", "taxonomy_term", "menu_link_content"],
    deniedEntityTypes: ["user"],
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
    allowedEntityTypes: null,         // set an explicit allowlist in your config
    deniedEntityTypes: ["user"],      // no user data at all
    entityRules: {},
    globalRedactedFields: ["pass", "mail", "field_private", "field_api_key", "field_token"],
  },
};

// ---------------------------------------------------------------------------
// Resolve effective security config for a site
// ---------------------------------------------------------------------------

export function resolveSecurityConfig(site) {
  const raw = site.security ?? {};
  const preset = PRESETS[raw.preset ?? "development"] ?? PRESETS.development;

  // Merge: explicit keys in site.security override the preset
  return {
    readOnly:              raw.readOnly              ?? preset.readOnly,
    allowDestructive:      raw.allowDestructive      ?? preset.allowDestructive,
    allowGraphqlMutations: raw.allowGraphqlMutations ?? preset.allowGraphqlMutations,
    allowedEntityTypes:    raw.allowedEntityTypes    ?? preset.allowedEntityTypes,
    deniedEntityTypes:     raw.deniedEntityTypes     ?? preset.deniedEntityTypes,
    entityRules:           mergeEntityRules(preset.entityRules, raw.entityRules ?? {}),
    globalRedactedFields:  [
      ...(preset.globalRedactedFields ?? []),
      ...(raw.globalRedactedFields    ?? []),
    ],
  };
}

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

export class SecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecurityError";
  }
}

// ---------------------------------------------------------------------------
// Assertion helpers — throw SecurityError if a check fails
// ---------------------------------------------------------------------------

export function assertNotReadOnly(secConfig, operationLabel) {
  if (secConfig.readOnly) {
    throw new SecurityError(
      `This site is configured as read-only. Operation blocked: ${operationLabel}. ` +
      "To enable writes, set security.readOnly = false in your config."
    );
  }
}

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

export function assertOperationAllowed(secConfig, operation, entityType) {
  // operation: "read" | "create" | "update" | "delete"
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

export function assertReadAllowed(secConfig, entityType, bundle) {
  assertEntityTypeAllowed(secConfig, entityType);
  if (bundle) assertBundleAllowed(secConfig, entityType, bundle);
  assertOperationAllowed(secConfig, "read", entityType);
}

export function assertWriteAllowed(secConfig, operation, entityType, bundle) {
  assertNotReadOnly(secConfig, `${operation} ${entityType}`);
  assertEntityTypeAllowed(secConfig, entityType);
  if (bundle) assertBundleAllowed(secConfig, entityType, bundle);
  assertOperationAllowed(secConfig, operation, entityType);
}

export function assertDeleteAllowed(secConfig, entityType, bundle, id) {
  assertDestructiveAllowed(secConfig, entityType, id);
  assertWriteAllowed(secConfig, "delete", entityType, bundle);
}

// ---------------------------------------------------------------------------
// Field redaction
// ---------------------------------------------------------------------------

/**
 * Redact sensitive fields from a JSON:API resource object (or array of them).
 * Modifies and returns the input — call after receiving API response.
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
 * Redact from a full JSON:API response (has .data which is object or array).
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

export function getSecuritySummary(site) {
  const cfg = resolveSecurityConfig(site);
  return {
    site:                  site._name,
    preset:                site.security?.preset ?? "development (default)",
    readOnly:              cfg.readOnly,
    allowDestructive:      cfg.allowDestructive,
    allowGraphqlMutations: cfg.allowGraphqlMutations,
    allowedEntityTypes:    cfg.allowedEntityTypes ?? "all",
    deniedEntityTypes:     cfg.deniedEntityTypes,
    entityRules:           cfg.entityRules,
    globalRedactedFields:  cfg.globalRedactedFields,
  };
}
