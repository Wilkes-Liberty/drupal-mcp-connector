/**
 * Tool group: Field introspection.
 *
 * Read-only discovery of the fields available on a Drupal entity type + bundle.
 *
 * The always-available source is `backend.getEntitySchema(entityType, bundle)`,
 * which derives a schema by SAMPLING an existing entity over JSON:API/GraphQL.
 * Sampling can only observe the fields a sampled entity happens to populate and
 * the runtime shape of their values — it CANNOT see authoritative Field API
 * metadata. So every result is flagged `approximate: true`, and per-field
 * `required` / `cardinality` / `allowedValues` are best-effort hints derived
 * from the sampled value shape (e.g. an `array<…>` sampled type implies a
 * multi-valued field). Authoritative metadata comes from the Drush bridge
 * (Field API: `field_config` / `base_field_definitions`), which these tools do
 * not require — see the `note` on the response.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertReadAllowed } from "../lib/security.js";

const SAMPLING_NOTE =
  "Schema derived by sampling an existing entity, so it is APPROXIMATE: only " +
  "fields populated on the sampled entity are visible, and required/cardinality/" +
  "allowedValues are inferred from value shape rather than read from Drupal's " +
  "Field API. For authoritative field definitions (required flags, exact " +
  "cardinality, allowed values, widget/storage settings) use the Drush bridge " +
  "(field config), which reads the Field API directly.";

const EMPTY_SCHEMA_NOTE =
  "No entities of this type/bundle exist yet, so sampling found no fields. " +
  "Create one entity, or use the Drush bridge (Field API), to introspect fields.";

/**
 * Infer a cardinality hint from a sampled attribute type string.
 * `getEntitySchema` reports list-valued fields as `array<...>`; a leading
 * `array<` is the only cheap multi-value signal sampling can give us.
 * @param {string} type Sampled type string from the backend schema.
 * @returns {{cardinality: number}|{}} `{cardinality: -1}` for arrays, else `{}`.
 */
function cardinalityHint(type) {
  return typeof type === "string" && type.startsWith("array<") ? { cardinality: -1 } : {};
}

/**
 * Build a per-field descriptor from a sampled attribute entry.
 * @param {string} name Field machine name.
 * @param {string} type Sampled type string.
 * @returns {object} `{ name, type, kind:'attribute', approximate, [cardinality] }`.
 */
function attributeField(name, type) {
  return { name, type, kind: "attribute", ...cardinalityHint(type), approximate: true };
}

/**
 * Build a per-field descriptor from a sampled relationship entry.
 * @param {string} name Relationship field machine name.
 * @returns {object} `{ name, type:'relationship', kind:'relationship', approximate }`.
 */
function relationshipField(name) {
  return { name, type: "relationship", kind: "relationship", approximate: true };
}

/**
 * Describe the fields of a Drupal entity type + bundle.
 *
 * Read-only. Builds on the always-available sampling schema and normalizes it
 * into a flat, per-field list with inferred hints. Always `approximate: true`.
 *
 * The entity type is accepted as either `type` or `entityType` (#116): the
 * sibling tools (get_entity_schema, entity_create/update, resolve_reference) use
 * `entityType`, and passing that name here previously slipped through as
 * `undefined` and surfaced a misleading access-denied error.
 *
 * @param {object} args - { site?, type|entityType, bundle? }. `bundle` defaults
 *   to the entity type (matching Drupal's single-bundle types, e.g. `user`).
 * @returns {Promise<{entityType: string, bundle: string, resourceType?: string,
 *   approximate: true, fieldCount: number, fields: object[], note: string,
 *   authoritativeSource: string}>}
 * @throws {SecurityError} If reading the type/bundle is not permitted.
 * @throws {Error} If no entity type is given under either name.
 */
async function describeFields({ site: siteName, type, entityType: entityTypeArg, bundle }) {
  const entityType = type ?? entityTypeArg;
  if (!entityType) {
    throw new Error(
      "drupal_describe_fields requires an entity type. Pass `type` (or its alias `entityType`), " +
      "e.g. { type: \"node\", bundle: \"article\" }."
    );
  }
  const resolvedBundle = bundle || entityType;

  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, resolvedBundle);

  const backend = await resolveBackend(site);
  const schema = await backend.getEntitySchema(entityType, resolvedBundle);

  const fields = [
    ...Object.entries(schema.attributes ?? {}).map(([name, t]) => attributeField(name, t)),
    ...Object.keys(schema.relationships ?? {}).map((name) => relationshipField(name)),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const sampledEmpty = fields.length === 0;

  return {
    entityType: schema.entityType ?? entityType,
    bundle: schema.bundle ?? resolvedBundle,
    ...(schema.resourceType ? { resourceType: schema.resourceType } : {}),
    approximate: true,
    fieldCount: fields.length,
    fields,
    note: sampledEmpty ? EMPTY_SCHEMA_NOTE : SAMPLING_NOTE,
    authoritativeSource: "drush-bridge (Drupal Field API)",
  };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_describe_fields",
    description:
      "Introspect the fields of a Drupal entity type + bundle: returns a per-field " +
      "list of { name, type, kind, cardinality?, approximate }. Read-only. Built on " +
      "schema SAMPLING (an existing entity), so results are approximate — only " +
      "populated fields are visible and required/cardinality/allowedValues are " +
      "inferred from value shape. Authoritative field metadata comes from the Drush " +
      "bridge (Field API). Use this before creating/updating entities to learn field names.",
    inputSchema: {
      type: "object",
      required: ["site"],
      properties: {
        site:   { type: "string", description: "Configured site name." },
        type:   { type: "string", description: "Entity type machine name, e.g. 'node', 'taxonomy_term', 'user', 'media'. Alias: `entityType` (as used by the sibling tools)." },
        entityType: { type: "string", description: "Alias for `type` — accepted for parity with get_entity_schema / entity_create / entity_update / resolve_reference." },
        bundle: { type: "string", description: "Bundle machine name, e.g. 'article'. Defaults to the entity type for single-bundle types (e.g. 'user')." },
      },
    },
  },
];

export const handlers = {
  drupal_describe_fields: describeFields,
};
