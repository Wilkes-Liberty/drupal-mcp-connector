/**
 * Generic entity tools — work with ANY Drupal entity type/bundle, backend-agnostic.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import {
  resolveSecurityConfig, assertReadAllowed, assertWriteAllowed, assertDeleteAllowed,
  redactCanonicalEntity, getSecuritySummary,
} from "../lib/security.js";

async function listEntities({ site: siteName, entityType, bundle, filters = [], sort = [], limit = 20, offset = 0, include = [] }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, bundle);
  const backend = await resolveBackend(site);
  const res = await backend.listEntities({ entityType, bundle, filters, sort, include, page: { limit, offset } });
  const entities = res.entities.map((e) => redactCanonicalEntity(e, sec, entityType));
  return { total: res.page?.total ?? entities.length, approximate: res.approximate ?? false, offset, nextOffset: offset + entities.length, entities };
}

async function getEntity({ site: siteName, entityType, bundle, id, include = [] }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, bundle);
  const backend = await resolveBackend(site);
  const entity = await backend.getEntity({ entityType, bundle, id, include });
  return entity ? redactCanonicalEntity(entity, sec, entityType) : null;
}

async function createEntity({ site: siteName, entityType, bundle, attributes = {}, relationships = {} }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "create", entityType, bundle);
  const backend = await resolveBackend(site);
  return backend.createEntity({ entityType, bundle, attributes, relationships });
}

async function updateEntity({ site: siteName, entityType, bundle, id, attributes = {}, relationships = {} }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", entityType, bundle);
  const backend = await resolveBackend(site);
  return backend.updateEntity({ entityType, bundle, id, attributes, relationships });
}

async function deleteEntity({ site: siteName, entityType, bundle, id }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertDeleteAllowed(sec, entityType, bundle, id);
  const backend = await resolveBackend(site);
  await backend.deleteEntity({ entityType, bundle, id });
  return { success: true, deletedId: id, entityType, bundle };
}

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

async function getEntitySchema({ site: siteName, entityType, bundle }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, bundle);
  const backend = await resolveBackend(site);
  return backend.getEntitySchema(entityType, bundle);
}

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
      },
    },
  },
  {
    name: "drupal_entity_update",
    description: "Update an existing entity of any Drupal entity type. Only include attributes/relationships you want to change.",
    inputSchema: {
      type: "object", required: ["entityType", "bundle", "id"],
      properties: {
        site:          { type: "string" },
        entityType:    { type: "string" },
        bundle:        { type: "string" },
        id:            { type: "string" },
        attributes:    { type: "object" },
        relationships: { type: "object" },
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
