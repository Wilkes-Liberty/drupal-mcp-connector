/**
 * Tool group: Bulk operations.
 *
 * Create or update many entities of a single type + bundle in one call. The
 * write permission is asserted ONCE up front (the whole batch targets one
 * type/bundle), then each item is processed in its own try/catch so a single
 * failure does not abort the batch — callers get partial success with a
 * per-item result and a roll-up summary.
 *
 * The hardened JSON:API backend is reused as-is (path validation, the
 * content_moderation status-on-403 fallback, etc. all apply per item).
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertWriteAllowed, assertPublishAllowed } from "../lib/security.js";

/**
 * Normalize an unknown thrown value into a human-readable message.
 *
 * @param {unknown} err - The caught error.
 * @returns {string} A message string.
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bulk-create entities of one type + bundle. Write permission is asserted once;
 * each item is created independently so the batch continues past failures.
 *
 * @param {object} args - { site?, entityType, bundle, items: [{ attributes?, relationships? }] }.
 * @returns {Promise<{results: object[], summary: {created: number, failed: number}}>}
 *   Per-item { index, success, id? | error } plus a roll-up summary.
 * @throws {SecurityError} If creating the type/bundle is not permitted.
 */
async function bulkCreate({ site: siteName, entityType, bundle, items = [] }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "create", entityType, bundle);
  const backend = await resolveBackend(site);

  const results = [];
  let created = 0;
  let failed = 0;
  for (const [index, rawItem] of items.entries()) {
    const item = rawItem || {};
    try {
      assertPublishAllowed(sec, item.attributes ?? {});
      const entity = await backend.createEntity({
        entityType, bundle,
        attributes: item.attributes ?? {},
        relationships: item.relationships ?? {},
      });
      created += 1;
      results.push({ index, success: true, id: entity?.id });
    } catch (err) {
      failed += 1;
      results.push({ index, success: false, error: errorMessage(err) });
    }
  }
  return { results, summary: { created, failed } };
}

/**
 * Bulk-update entities of one type + bundle. Write permission is asserted once;
 * each item is updated independently so the batch continues past failures. An
 * item missing an id is reported as a per-item failure rather than aborting.
 *
 * @param {object} args - { site?, entityType, bundle, items: [{ id, attributes?, relationships? }] }.
 * @returns {Promise<{results: object[], summary: {updated: number, failed: number}}>}
 *   Per-item { index, success, id? | error } plus a roll-up summary.
 * @throws {SecurityError} If updating the type/bundle is not permitted.
 */
async function bulkUpdate({ site: siteName, entityType, bundle, items = [] }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", entityType, bundle);
  const backend = await resolveBackend(site);

  const results = [];
  let updated = 0;
  let failed = 0;
  for (const [index, rawItem] of items.entries()) {
    const item = rawItem || {};
    try {
      if (!item.id) throw new Error("Missing 'id' for update item");
      assertPublishAllowed(sec, item.attributes ?? {});
      const entity = await backend.updateEntity({
        entityType, bundle, id: item.id,
        attributes: item.attributes ?? {},
        relationships: item.relationships ?? {},
      });
      updated += 1;
      results.push({ index, success: true, id: entity?.id ?? item.id });
    } catch (err) {
      failed += 1;
      results.push({ index, success: false, error: errorMessage(err) });
    }
  }
  return { results, summary: { updated, failed } };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const itemAttributesSchema = {
  attributes:    { type: "object", description: "Field values keyed by Drupal machine name" },
  relationships: { type: "object", description: "Relationship data keyed by field name" },
};

export const definitions = [
  {
    name: "drupal_bulk_create",
    description: "Create many entities of a single type + bundle in one call. Permission is checked once; each item is created independently, so the batch continues past individual failures (partial success). Returns per-item { index, success, id | error } and a summary { created, failed }. Writes default to unpublished/draft.",
    inputSchema: {
      type: "object", required: ["entityType", "bundle", "items"],
      properties: {
        site:       { type: "string" },
        entityType: { type: "string", description: "Entity type machine name, e.g. 'node', 'taxonomy_term'" },
        bundle:     { type: "string", description: "Bundle machine name, e.g. 'article'" },
        items: {
          type: "array",
          description: "Entities to create. Each is { attributes?, relationships? }.",
          items: { type: "object", properties: { ...itemAttributesSchema } },
        },
      },
    },
  },
  {
    name: "drupal_bulk_update",
    description: "Update many entities of a single type + bundle in one call. Permission is checked once; each item is updated independently, so the batch continues past individual failures (partial success). Each item requires an 'id' (UUID); items missing an id are reported as per-item failures. Returns per-item { index, success, id | error } and a summary { updated, failed }.",
    inputSchema: {
      type: "object", required: ["entityType", "bundle", "items"],
      properties: {
        site:       { type: "string" },
        entityType: { type: "string", description: "Entity type machine name" },
        bundle:     { type: "string", description: "Bundle machine name" },
        items: {
          type: "array",
          description: "Entities to update. Each is { id, attributes?, relationships? }.",
          items: {
            type: "object", required: ["id"],
            properties: { id: { type: "string", description: "Entity UUID" }, ...itemAttributesSchema },
          },
        },
      },
    },
  },
];

export const handlers = {
  drupal_bulk_create: bulkCreate,
  drupal_bulk_update: bulkUpdate,
};
