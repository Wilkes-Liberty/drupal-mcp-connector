/**
 * Tool group: Reference resolution.
 *
 * A standalone, read-only helper that turns a human-friendly name or title into
 * a stable Drupal UUID. Editors and agents rarely know UUIDs; they know labels
 * ("the News term", "the About page"). This tool runs a single label filter via
 * the backend's listEntities, ranks the results, and returns the best match plus
 * any ambiguous candidates so the caller (or a human) can disambiguate before
 * wiring the UUID into a create/update relationship.
 *
 * Scope: this NEVER writes. It only reads, and every read is gated by the site
 * security policy (assertReadAllowed) and redacted (redactCanonicalEntity) before
 * a label is derived — so a redacted label surfaces as "[REDACTED]" rather than
 * leaking a protected value.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertReadAllowed, redactCanonicalEntity } from "../lib/security.js";

/**
 * Pick the label field to filter on for a given entity type.
 *
 * Nodes are keyed by `title`; taxonomy terms and users (and other label-as-name
 * entities) are keyed by `name`. Anything else defaults to `name`, which is the
 * most common Drupal label field outside of content nodes.
 *
 * @param {string} entityType Entity type machine name.
 * @returns {"title"|"name"} The JSON:API field to filter against.
 */
function labelFieldFor(entityType) {
  return entityType === "node" ? "title" : "name";
}

/**
 * Derive a human label from a (already redacted) canonical entity.
 *
 * Nodes promote their label to the canonical `title`; taxonomy terms / users
 * keep it in `fields.name`. We fall back across both so the resolver returns a
 * meaningful label regardless of entity type. Redaction runs before this, so a
 * protected label is already "[REDACTED]" here.
 *
 * @param {object} entity Redacted canonical entity.
 * @param {string} labelField The field used for filtering ("title"|"name").
 * @returns {?string} The best available label, or null.
 */
function labelOf(entity, labelField) {
  return (
    entity.title ??
    // eslint-disable-next-line security/detect-object-injection -- labelField is a fixed literal ("title"|"name") from labelFieldFor, not user input
    entity.fields?.[labelField] ??
    entity.fields?.name ??
    entity.fields?.title ??
    null
  );
}

/**
 * Resolve a human name/title to a Drupal UUID.
 *
 * Strategy: filter the entity type/bundle by a label-contains query, redact the
 * results, then rank — an exact (case-insensitive, trimmed) label match wins;
 * otherwise the first contains-match is the best guess and the result is flagged
 * ambiguous when more than one candidate came back without an exact hit.
 *
 * @param {object} args - { site?, entityType, bundle, name, limit? }.
 * @returns {Promise<{resolved: boolean, ambiguous: boolean,
 *   match: {id: string, title: ?string}|null, candidates: {id: string, title: ?string}[]}>}
 *   The best match and any ambiguous candidates.
 * @throws {SecurityError} If reading the entity type/bundle is not permitted.
 */
async function resolveReference({ site: siteName, entityType, bundle, name, limit = 10 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, bundle);
  const backend = await resolveBackend(site);

  const field = labelFieldFor(entityType);
  const res = await backend.listEntities({
    entityType,
    bundle,
    filters: [{ field, op: "contains", value: name }],
    page: { limit },
  });

  const candidates = res.entities
    .map((e) => redactCanonicalEntity(e, sec, entityType))
    .map((e) => ({ id: e.id, title: labelOf(e, field) }));

  if (candidates.length === 0) {
    return { resolved: false, ambiguous: false, match: null, candidates: [] };
  }

  const needle = String(name).trim().toLowerCase();
  const exact = candidates.find(
    (c) => typeof c.title === "string" && c.title.trim().toLowerCase() === needle
  );
  const match = exact ?? candidates[0];
  const ambiguous = !exact && candidates.length > 1;

  return { resolved: true, ambiguous, match, candidates };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_resolve_reference",
    description:
      "Resolve a human name or title to a Drupal entity UUID. Use this before " +
      "creating or updating an entity reference when you only know the label " +
      "(e.g. a taxonomy term name, a user name, or a node title) and not its UUID. " +
      "Read-only: returns the best match { id, title } plus any ambiguous candidates. " +
      "Filters on 'title' for nodes and 'name' for taxonomy_term / user.",
    inputSchema: {
      type: "object",
      required: ["entityType", "bundle", "name"],
      properties: {
        site:       { type: "string", description: "Named site (omit for default)" },
        entityType: { type: "string", description: "Entity type machine name, e.g. 'node', 'taxonomy_term', 'user'" },
        bundle:     { type: "string", description: "Bundle machine name, e.g. 'article', 'tags', 'user'" },
        name:       { type: "string", description: "Human name/title to resolve (matched as a substring)" },
        limit:      { type: "number", default: 10, description: "Maximum candidates to consider" },
      },
    },
  },
];

export const handlers = {
  drupal_resolve_reference: resolveReference,
};
