/**
 * Tool group: Additional audit & reporting (reports_extra).
 *
 * Read-only content-quality and referential-integrity audits that complement
 * the core reports module. Each handler asserts read access in-handler and
 * returns a structured finding list. Reports that are bounded by a sampling cap
 * flag `approximate: true` so callers know the result is best-effort rather than
 * an exhaustive scan.
 *
 * This module deliberately does NOT touch src/tools/reports.js — it is additive.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertReadAllowed } from "../lib/security.js";
import { collectEntities, fieldValue } from "../lib/reports-support.js";

/**
 * Determine whether a canonical field/relationship value counts as "empty".
 * Handles scalars, JSON:API value-objects ({value}), arrays, and relationship
 * refs ({id} / [{id}, …] / null).
 * @param {*} value A value read off an entity's base props, `fields`, or `relationships`.
 * @returns {boolean} True when the value is absent or carries no content.
 */
function isEmptyValue(value) {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    // Relationship ref ({id, ...}) is non-empty.
    if ("id" in value) return !value.id;
    // JSON:API field value-object ({value, ...}); also accept {target_id}/{uri}.
    if ("value" in value) return value.value === undefined || value.value === null || value.value === "";
    if ("target_id" in value) return value.target_id === undefined || value.target_id === null;
    if ("uri" in value) return !value.uri;
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * Read a field value from a canonical entity, looking in `fields` first and then
 * `relationships` (so a single `field` argument works for both scalar fields and
 * entity-reference fields).
 * @param {object} entity Canonical entity.
 * @param {string} field Field machine name.
 * @returns {{value: *, present: boolean}} The resolved value and whether the key existed at all.
 */
function readField(entity, field) {
  const fromField = fieldValue(entity, [field]);
  if (fromField !== undefined) return { value: fromField, present: true };
  const rels = new Map(Object.entries(entity.relationships ?? {}));
  if (rels.has(field)) {
    return { value: rels.get(field), present: true };
  }
  return { value: undefined, present: false };
}

/**
 * Flatten a relationship value into an array of { id, entityType, bundle } refs,
 * dropping null/empty entries.
 * @param {*} rel A normalized relationship value (ref, array of refs, or null).
 * @returns {Array<{id: string, entityType: ?string, bundle: ?string}>} Concrete refs, de-duped by id.
 */
function refsOf(rel) {
  if (!rel) return [];
  const list = Array.isArray(rel) ? rel : [rel];
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report implementations
// ---------------------------------------------------------------------------

/**
 * Unpublished / draft content for a content type.
 *
 * @param {object} args - { site?, type?, limit? }. `type` defaults to "article".
 * @returns {Promise<{contentType: string, approximate: boolean,
 *   totalUnpublished: number, findings: object[]}>} Matching unpublished nodes.
 * @throws {SecurityError} If reading the content type is not permitted.
 */
async function unpublished({ site: siteName, type, limit = 50 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const res = await backend.listEntities({
    entityType: "node", bundle: contentType,
    filters: [{ field: "status", op: "eq", value: false }],
    sort: [{ field: "changed", dir: "desc" }],
    page: { limit },
  });
  return {
    contentType,
    approximate: res.approximate ?? false,
    totalUnpublished: res.page?.total ?? res.entities.length,
    findings: res.entities.map((n) => ({
      id: n.id,
      title: n.title,
      status: "unpublished",
      changed: n.changed,
      path: n.url,
    })),
  };
}

/**
 * Entities of a content type where a given field is empty (e.g. a missing meta
 * description or image). Works for scalar fields and entity-reference fields.
 * Sampling-bounded: flags `approximate` when the scan hits the sample cap while
 * more results remain.
 *
 * @param {object} args - { site?, type?, field, sampleSize? }. `field` is required.
 * @returns {Promise<object>} Per-entity findings plus scan metadata.
 * @throws {Error} If no field is supplied.
 * @throws {SecurityError} If reading the content type is not permitted.
 */
async function missingField({ site: siteName, type, field, sampleSize = 100 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  if (!field) throw new Error("missingField requires a field machine name.");
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const entities = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, sort: [{ field: "changed", dir: "desc" }] },
    sampleSize
  );
  const findings = [];
  for (const e of entities) {
    const { value } = readField(e, field);
    if (isEmptyValue(value)) {
      findings.push({ id: e.id, title: e.title, field, status: e.status ? "published" : "unpublished", path: e.url });
    }
  }
  const approximate = entities.length >= sampleSize;
  return {
    contentType,
    field,
    scanned: entities.length,
    sampled: entities.length,
    sampleSize,
    approximate,
    totalMissing: findings.length,
    note: approximate
      ? "Result is sampling-bounded; more entities may exist beyond the sample cap."
      : undefined,
    findings,
  };
}

/**
 * Orphaned entity references: sampled entities whose entity-reference fields
 * point at targets that no longer exist. Best-effort — each distinct referenced
 * target is probed once via getEntity; a null result or a fetch error is treated
 * as an unresolved (orphaned) target. Sampling-bounded, so `approximate` is set
 * when the entity scan is capped.
 *
 * @param {object} args - { site?, type?, sampleSize? }. `type` defaults to "article".
 * @returns {Promise<object>} Orphaned-reference findings plus scan metadata.
 * @throws {SecurityError} If reading the content type is not permitted.
 */
async function orphanedReferences({ site: siteName, type, sampleSize = 50 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const contentType = type || "article";
  const entities = await collectEntities(
    backend,
    { entityType: "node", bundle: contentType, sort: [{ field: "changed", dir: "desc" }] },
    sampleSize
  );

  // Cache resolution results across all sampled entities so a target is only
  // looked up once (de-dupes both within and across entities).
  const resolution = new Map(); // id -> boolean (true = exists)
  /**
   * Resolve whether a referenced target exists, caching the result.
   * @param {{id: string, entityType: ?string, bundle: ?string}} ref Reference to probe.
   * @returns {Promise<boolean>} True if the target resolves to an entity.
   */
  async function exists(ref) {
    if (resolution.has(ref.id)) return resolution.get(ref.id);
    let ok = false;
    try {
      // entityType/bundle are derived from JSON:API "type"; both required to fetch.
      if (ref.entityType && ref.bundle) {
        const target = await backend.getEntity({ entityType: ref.entityType, bundle: ref.bundle, id: ref.id });
        ok = Boolean(target);
      } else {
        // Cannot address the target without a concrete type+bundle; treat as
        // unresolved rather than silently passing.
        ok = false;
      }
    } catch {
      ok = false;
    }
    resolution.set(ref.id, ok);
    return ok;
  }

  const findings = [];
  for (const e of entities) {
    for (const [fieldName, rel] of Object.entries(e.relationships ?? {})) {
      for (const ref of refsOf(rel)) {
        const ok = await exists(ref);
        if (!ok) {
          findings.push({
            id: e.id,
            title: e.title,
            field: fieldName,
            targetId: ref.id,
            targetEntityType: ref.entityType,
            targetBundle: ref.bundle,
          });
        }
      }
    }
  }

  const approximate = entities.length >= sampleSize;
  return {
    contentType,
    scanned: entities.length,
    sampleSize,
    approximate,
    totalOrphaned: findings.length,
    note: approximate
      ? "Best-effort: reference integrity is checked over a sampling-bounded set of entities."
      : "Best-effort: each referenced target is probed once via JSON:API.",
    findings,
  };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_report_unpublished",
    description: "List unpublished/draft content of a given type. Returns a finding list with titles, last-changed dates, and paths. Useful for surfacing forgotten drafts.",
    inputSchema: {
      type: "object",
      properties: {
        site:  { type: "string" },
        type:  { type: "string", description: "Content type machine name (default: article)" },
        limit: { type: "number", default: 50, description: "Max unpublished nodes to return" },
      },
    },
  },
  {
    name: "drupal_report_missing_field",
    description: "Find entities of a content type where a given field is empty (e.g. a missing meta description, image, or summary). Works for scalar fields and entity-reference fields. Sampling-bounded — flags 'approximate' when the scan is capped.",
    inputSchema: {
      type: "object", required: ["field"],
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type machine name (default: article)" },
        field:      { type: "string", description: "Field machine name to check for emptiness, e.g. 'field_meta_description', 'field_image'" },
        sampleSize: { type: "number", default: 100, description: "Max entities to scan" },
      },
    },
  },
  {
    name: "drupal_report_orphaned_references",
    description: "Find entities whose entity-reference fields point at targets that no longer exist (orphaned references). Best-effort: samples entities and probes each distinct referenced target via JSON:API. Flags 'approximate' when sampling-bounded.",
    inputSchema: {
      type: "object",
      properties: {
        site:       { type: "string" },
        type:       { type: "string", description: "Content type machine name to scan (default: article)" },
        sampleSize: { type: "number", default: 50, description: "Max entities to scan for broken references" },
      },
    },
  },
];

export const handlers = {
  drupal_report_unpublished:           unpublished,
  drupal_report_missing_field:         missingField,
  drupal_report_orphaned_references:   orphanedReferences,
};
