/**
 * Node CRUD tools — backend-agnostic (JSON:API or GraphQL) via resolveBackend.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, redactCanonicalEntity } from "../lib/security.js";

function buildBodyAttribute(body, summary) {
  if (body === undefined) return undefined;
  return { value: body, format: "full_html", summary: summary ?? "" };
}

function pageOf({ limit = 20, offset = 0 }) {
  return { limit, offset };
}

async function getNode({ site: siteName, type, id }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const entity = await backend.getEntity({ entityType: "node", bundle: type, id });
  return entity ? redactCanonicalEntity(entity, sec, "node") : null;
}

async function listNodes({ site: siteName, type, status, filters = [], limit = 20, offset = 0, sort = [{ field: "changed", dir: "desc" }] }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const allFilters = [...filters];
  if (status !== undefined) allFilters.push({ field: "status", op: "eq", value: status });
  const res = await backend.listEntities({ entityType: "node", bundle: type, filters: allFilters, sort, page: pageOf({ limit, offset }) });
  const nodes = res.entities.map((e) => redactCanonicalEntity(e, sec, "node"));
  return {
    total: res.page?.total ?? nodes.length,
    approximate: res.approximate ?? false,
    offset,
    nextOffset: offset + nodes.length,
    nodes,
  };
}

async function searchContent({ site: siteName, query, type, status, limit = 10 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const filters = [{ field: "title", op: "contains", value: query }];
  if (status !== undefined) filters.push({ field: "status", op: "eq", value: status });
  const res = await backend.listEntities({ entityType: "node", bundle: type || "article", filters, sort: [{ field: "changed", dir: "desc" }], page: { limit } });
  return res.entities.map((e) => redactCanonicalEntity(e, sec, "node"));
}

async function createNode({ site: siteName, type, title, body, summary, status = false, fields = {} }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  const attributes = { title, status, ...fields };
  const bodyAttr = buildBodyAttribute(body, summary);
  if (bodyAttr) attributes.body = bodyAttr;
  return backend.createEntity({ entityType: "node", bundle: type, attributes });
}

async function updateNode({ site: siteName, type, id, title, body, summary, status, fields = {} }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  const attributes = { ...fields };
  if (title !== undefined) attributes.title = title;
  if (status !== undefined) attributes.status = status;
  const bodyAttr = buildBodyAttribute(body, summary);
  if (bodyAttr) attributes.body = bodyAttr;
  return backend.updateEntity({ entityType: "node", bundle: type, id, attributes });
}

async function deleteNode({ site: siteName, type, id }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  await backend.deleteEntity({ entityType: "node", bundle: type, id });
  return { success: true, deletedId: id };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_get_node",
    description: "Fetch a single Drupal content node by UUID and content type. Returns title, body, status, path alias, and all attributes.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site: { type: "string", description: "Named site (omit for default)" },
        type: { type: "string", description: "Content type machine name, e.g. 'article'" },
        id:   { type: "string", description: "Node UUID" },
      },
    },
  },
  {
    name: "drupal_list_nodes",
    description: "List nodes of a given content type. Supports status filtering, pagination, sorting, and structured filter descriptors.",
    inputSchema: {
      type: "object", required: ["type"],
      properties: {
        site:    { type: "string" },
        type:    { type: "string", description: "Content type machine name" },
        status:  { type: "boolean", description: "true = published only, false = unpublished only, omit = all" },
        limit:   { type: "number", default: 20 },
        offset:  { type: "number", default: 0 },
        filters: { type: "array", description: "Structured filters: [{ field, op, value }]. op: eq|neq|gt|gte|lt|lte|contains|in|isNull", items: { type: "object" } },
        sort:    { type: "array", description: "Sort specs: [{ field, dir }] where dir is 'asc'|'desc'", items: { type: "object" } },
      },
    },
  },
  {
    name: "drupal_search_content",
    description: "Search nodes by title substring. Returns title, path alias, and body summary.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        site:   { type: "string" },
        query:  { type: "string", description: "Search term to match against node titles" },
        type:   { type: "string", description: "Limit to this content type (default: article)" },
        status: { type: "boolean", description: "Filter by publish status" },
        limit:  { type: "number", default: 10 },
      },
    },
  },
  {
    name: "drupal_create_node",
    description: "Create a new content node. Returns the new node UUID, integer ID, and URL.",
    inputSchema: {
      type: "object", required: ["type", "title"],
      properties: {
        site:    { type: "string" },
        type:    { type: "string", description: "Content type machine name" },
        title:   { type: "string" },
        body:    { type: "string", description: "Body field HTML" },
        summary: { type: "string", description: "Body summary / teaser" },
        status:  { type: "boolean", default: false, description: "true to publish immediately" },
        fields:  { type: "object", description: "Additional field values keyed by Drupal machine name" },
      },
    },
  },
  {
    name: "drupal_update_node",
    description: "Update an existing node. Only include fields you want to change.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site:    { type: "string" },
        type:    { type: "string" },
        id:      { type: "string", description: "Node UUID" },
        title:   { type: "string" },
        body:    { type: "string" },
        summary: { type: "string" },
        status:  { type: "boolean", description: "true = publish, false = unpublish" },
        fields:  { type: "object" },
      },
    },
  },
  {
    name: "drupal_delete_node",
    description: "Permanently delete a node. Irreversible — confirm with the user before calling.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site: { type: "string" },
        type: { type: "string" },
        id:   { type: "string", description: "Node UUID" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handler map
// ---------------------------------------------------------------------------

export const handlers = {
  drupal_get_node:       getNode,
  drupal_list_nodes:     listNodes,
  drupal_search_content: searchContent,
  drupal_create_node:    createNode,
  drupal_update_node:    updateNode,
  drupal_delete_node:    deleteNode,
};
