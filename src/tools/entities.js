/**
 * Tool group: Generic entities.
 *
 * Type-agnostic CRUD plus schema/type discovery and a security summary. These
 * tools work with ANY Drupal entity type + bundle, so each handler asserts the
 * appropriate read/write/delete permission in-handler (the name-prefix gating
 * in index.js cannot know the entity type from the generic tool names). Reads
 * are redacted per the site policy.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { shapeWriteResponse, flagUnrequestedStatusChange, RETURNING_SCHEMA } from "../lib/entity-response.js";
import { applySafeDraftDefault, hasExplicitModerationState } from "../lib/moderation-default.js";
import {
  resolveErrRelationships, relationshipsWereSent, embedParagraphRef,
  resolveParagraphRevisionId, missingParagraphRevisionError,
} from "../lib/err-relationships.js";
import { readWrittenRevision } from "../lib/write-revision.js";
import { preflightPatchWritable, updateEntityGuarded } from "../lib/patch-preflight.js";
import {
  resolveSecurityConfig, assertReadAllowed, assertWriteAllowed, assertDeleteAllowed, assertPublishAllowed,
  redactCanonicalEntity, getSecuritySummary,
} from "../lib/security.js";

/**
 * List entities of any type/bundle with filters, sort, includes and paging.
 *
 * @param {object} args - { site?, entityType, bundle, filters?, sort?, limit?, offset?, include? }.
 * @returns {Promise<{total: number, approximate: boolean, offset: number,
 *   nextOffset: number, entities: object[]}>} Paged, redacted entity list.
 * @throws {SecurityError} If reading the type/bundle is not permitted.
 */
async function listEntities({ site: siteName, entityType, bundle, filters = [], sort = [], limit = 20, offset = 0, include = [] }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, bundle);
  const backend = await resolveBackend(site);
  const res = await backend.listEntities({ entityType, bundle, filters, sort, include, page: { limit, offset } });
  const entities = res.entities.map((e) => redactCanonicalEntity(e, sec, entityType));
  return { total: res.page?.total ?? entities.length, approximate: res.approximate ?? false, offset, nextOffset: offset + entities.length, entities };
}

/**
 * Fetch a single entity of any type by UUID, redacted per policy.
 *
 * @param {object} args - { site?, entityType, bundle, id, include? }.
 * @returns {Promise<object|null>} The redacted entity, or null if not found.
 * @throws {SecurityError} If reading the type/bundle is not permitted.
 */
async function getEntity({ site: siteName, entityType, bundle, id, include = [] }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, bundle);
  const backend = await resolveBackend(site);
  const entity = await backend.getEntity({ entityType, bundle, id, include });
  return entity ? redactCanonicalEntity(entity, sec, entityType) : null;
}

/**
 * Create an entity of any type/bundle.
 *
 * @param {object} args - { site?, entityType, bundle, attributes?, relationships? }.
 * @returns {Promise<object>} The created entity descriptor.
 * @throws {SecurityError} If creating the type/bundle is not permitted.
 */
async function createEntity({ site: siteName, entityType, bundle, attributes = {}, relationships = {}, dryRun = false, returning = "full" }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "create", entityType, bundle);
  assertPublishAllowed(sec, attributes);
  const backend = await resolveBackend(site);
  const resolvedRelationships = await resolveErrRelationships(backend, relationships);
  if (dryRun) return { dryRun: true, operation: "create", entityType, bundle, attributes, relationships: resolvedRelationships };
  const created = await backend.createEntity({ entityType, bundle, attributes, relationships: resolvedRelationships });
  if (entityType === "paragraph") {
    const revisionId = await resolveParagraphRevisionId(backend, created, bundle);
    if (revisionId === null) throw missingParagraphRevisionError(created.id);
    created.relationshipData = embedParagraphRef(created.bundle || bundle, created.id, revisionId);
  }
  return shapeWriteResponse(created, returning);
}

/**
 * Update an entity of any type/bundle (partial — only supplied fields are sent).
 *
 * Safe default (#131): published moderated targets without an explicit
 * `moderation_state` get `moderation_state: draft` so the write is a forward
 * revision rather than a live default-revision mutation.
 *
 * Live-state mediation (#171): `status` is never added to the PATCH unless the
 * caller passed it, and an unrequested published-state flip in the write result
 * is reported via `_statusChanged` rather than returned silently.
 *
 * @param {object} args - { site?, entityType, bundle, id, attributes?, relationships? }.
 * @returns {Promise<object>} The updated entity descriptor.
 * @throws {SecurityError} If updating the type/bundle is not permitted.
 */
async function updateEntity({ site: siteName, entityType, bundle, id, attributes = {}, relationships = {}, dryRun = false, returning = "full" }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", entityType, bundle);
  const backend = await resolveBackend(site);
  // One pre-write read serves both the #131 draft default and the #171
  // unrequested-status-change flag. Skipped when the caller pinned the
  // moderation state explicitly (same condition the draft default uses).
  let existing = null;
  if (!hasExplicitModerationState(attributes)) {
    try {
      existing = (await backend.getEntity({ entityType, bundle, id })) ?? null;
    } catch {
      existing = null; // Unreadable target: server-side gates stay authoritative.
    }
  }
  const safeAttributes = await applySafeDraftDefault({
    backend, entityType, bundle, id, attributes, existingEntity: existing,
  });
  assertPublishAllowed(sec, safeAttributes);
  const resolvedRelationships = await resolveErrRelationships(backend, relationships);
  await preflightPatchWritable({
    backend, entityType, bundle, id, existing, attributes: safeAttributes,
  });
  if (dryRun) {
    return {
      dryRun: true, operation: "update", entityType, bundle, id,
      attributes: safeAttributes, relationships: resolvedRelationships,
    };
  }
  const result = await updateEntityGuarded(backend, {
    entityType, bundle, id, attributes: safeAttributes, relationships: resolvedRelationships,
  });
  const written = await readWrittenRevision({
    backend, entityType, bundle, id,
    relationshipsSent: relationshipsWereSent(resolvedRelationships),
    patchResult: result,
    preferCanonical: false,
  });
  return shapeWriteResponse(flagUnrequestedStatusChange(written, existing, safeAttributes), returning);
}

/**
 * Delete an entity of any type/bundle. Requires allowDestructive in policy.
 *
 * @param {object} args - { site?, entityType, bundle, id }.
 * @returns {Promise<{success: boolean, deletedId: string, entityType: string, bundle: string}>}
 * @throws {SecurityError} If deleting the type/bundle is not permitted.
 */
async function deleteEntity({ site: siteName, entityType, bundle, id, dryRun = false }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertDeleteAllowed(sec, entityType, bundle, id);
  if (dryRun) return { dryRun: true, operation: "delete", entityType, bundle, id };
  const backend = await resolveBackend(site);
  await backend.deleteEntity({ entityType, bundle, id });
  return { success: true, deletedId: id, entityType, bundle };
}

/**
 * Discover all resource types the backend exposes, filtered to those the policy
 * permits reading. Accessibility is probed per type by catching the assertion
 * (rather than indexing a policy table), which keeps the lookup injection-safe.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<{total: number, accessible: number, blocked: number,
 *   resourceTypes: object[]}>} Counts plus the list of readable types.
 */
async function listEntityTypes({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const all = await backend.listResourceTypes();
  const accessible = all.filter(({ entityType, bundle }) => {
    try { assertReadAllowed(sec, entityType, bundle); return true; } catch { return false; }
  });
  return { total: all.length, accessible: accessible.length, blocked: all.length - accessible.length, resourceTypes: accessible };
}

/**
 * Return the field/relationship schema for a type + bundle.
 *
 * @param {object} args - { site?, entityType, bundle }.
 * @returns {Promise<object>} The backend's schema descriptor.
 * @throws {SecurityError} If reading the type/bundle is not permitted.
 */
async function getEntitySchema({ site: siteName, entityType, bundle }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, bundle);
  const backend = await resolveBackend(site);
  return backend.getEntitySchema(entityType, bundle);
}

/**
 * Summarize the active security policy for a site (allowed/blocked/redacted).
 * No backend call — reads policy only.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<object>} The security summary.
 */
async function securityInfo({ site: siteName }) {
  const site = getSiteConfig(siteName);
  return getSecuritySummary(site);
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_list_entity_types",
    description: "Discover all JSON:API resource types (entity types + bundles) exposed by this Drupal site, filtered to only those your security config allows. Run this before working with an unfamiliar entity type.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
    },
  },
  {
    name: "drupal_get_entity_schema",
    description: "Inspect the fields and relationships available on any Drupal entity type + bundle. Run this before creating or updating entities to know what fields are available.",
    inputSchema: {
      type: "object", required: ["entityType", "bundle"],
      properties: {
        site:       { type: "string" },
        entityType: { type: "string", description: "e.g. 'node', 'paragraph', 'commerce_product', 'block_content'" },
        bundle:     { type: "string", description: "e.g. 'article', 'text', 'default'" },
      },
    },
  },
  {
    name: "drupal_entity_list",
    description: "List entities of any Drupal entity type and bundle. Supports structured filters, sorting, pagination, and relationship includes. Use drupal_list_entity_types first to discover available types.",
    inputSchema: {
      type: "object", required: ["entityType", "bundle"],
      properties: {
        site:       { type: "string" },
        entityType: { type: "string", description: "Entity type machine name, e.g. 'paragraph', 'block_content', 'commerce_product'" },
        bundle:     { type: "string", description: "Bundle machine name" },
        filters:    { type: "array", description: "Structured filters: [{ field, op, value }]", items: { type: "object" } },
        sort:       { type: "array", description: "Sort specs: [{ field, dir }]", items: { type: "object" } },
        include:    { type: "array", description: "Relationship field names to sideload", items: { type: "string" } },
        limit:      { type: "number", default: 20 },
        offset:     { type: "number", default: 0 },
      },
    },
  },
  {
    name: "drupal_entity_get",
    description: "Fetch a single entity of any Drupal entity type by UUID.",
    inputSchema: {
      type: "object", required: ["entityType", "bundle", "id"],
      properties: {
        site:       { type: "string" },
        entityType: { type: "string" },
        bundle:     { type: "string" },
        id:         { type: "string", description: "Entity UUID" },
        include:    { type: "array", description: "Relationship field names to sideload", items: { type: "string" } },
      },
    },
  },
  {
    name: "drupal_entity_create",
    description: "Create an entity of any Drupal entity type and bundle. Use drupal_get_entity_schema first to know what fields are available. All operations checked against security config.",
    inputSchema: {
      type: "object", required: ["entityType", "bundle"],
      properties: {
        site:          { type: "string" },
        entityType:    { type: "string" },
        bundle:        { type: "string" },
        attributes:    { type: "object", description: "Field values keyed by Drupal machine name" },
        relationships: { type: "object", description: "Relationship data keyed by field name" },
        dryRun:        { type: "boolean", default: false, description: "Validate and return a preview of the create without committing." },
        returning:     RETURNING_SCHEMA,
      },
    },
  },
  {
    name: "drupal_entity_update",
    description: "Update an existing entity of any Drupal entity type. Only include attributes/relationships you want to change. Published moderated targets without an explicit attributes.moderation_state default to moderation_state 'draft' (forward revision). Paragraph / ERR identifiers are resolved to include meta.target_revision_id before PATCH; the write fails if any ref cannot be resolved. On moderated targets an id-mismatch PATCH preflight runs first (including dryRun) so a core working-copy guard failure is reported before the real write and no revision is saved by the probe (#201). Preflight does not un-orphan paragraphs already created — probe the host before creating dependents.",
    inputSchema: {
      type: "object", required: ["entityType", "bundle", "id"],
      properties: {
        site:          { type: "string" },
        entityType:    { type: "string" },
        bundle:        { type: "string" },
        id:            { type: "string" },
        attributes:    { type: "object" },
        relationships: { type: "object" },
        dryRun:        { type: "boolean", default: false, description: "Validate, resolve ERR identifiers, and (on moderated targets) run the core PATCH-guard probe against Drupal, then return a preview without the real write. The probe uses a non-matching data.id so Drupal does not save. A working-copy 400 fails the dryRun." },
        returning:     RETURNING_SCHEMA,
      },
    },
  },
  {
    name: "drupal_entity_delete",
    description: "Delete an entity of any Drupal entity type. Requires allowDestructive = true in security config. Confirm with the user before calling.",
    inputSchema: {
      type: "object", required: ["entityType", "bundle", "id"],
      properties: {
        site:       { type: "string" },
        entityType: { type: "string" },
        bundle:     { type: "string" },
        id:         { type: "string" },
        dryRun:     { type: "boolean", default: false, description: "Validate and return a preview of the delete without committing." },
      },
    },
  },
  {
    name: "drupal_security_info",
    description: "Show the active security configuration for a site — what's allowed, what's blocked, what fields are redacted. Run this to understand the current access policy.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
    },
  },
];

export const handlers = {
  drupal_list_entity_types:  listEntityTypes,
  drupal_get_entity_schema:  getEntitySchema,
  drupal_entity_list:        listEntities,
  drupal_entity_get:         getEntity,
  drupal_entity_create:      createEntity,
  drupal_entity_update:      updateEntity,
  drupal_entity_delete:      deleteEntity,
  drupal_security_info:      securityInfo,
};
