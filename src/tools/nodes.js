/**
 * Tool group: Node CRUD.
 *
 * Backend-agnostic content node operations (get/list/search/create/update/
 * delete). Every handler resolves the active backend (JSON:API or GraphQL) via
 * resolveBackend, and read results pass through redactCanonicalEntity so the
 * per-site security policy can strip protected fields before returning.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, redactCanonicalEntity, assertWriteAllowed, assertPublishAllowed } from "../lib/security.js";
import { shapeWriteResponse, RETURNING_SCHEMA } from "../lib/entity-response.js";
import { buildRedirectAttributes, REDIRECT_ENTITY_TYPE } from "./redirects.js";

/** Fallback language for an alias when the node exposes none. */
const DEFAULT_ALIAS_LANGCODE = "en";

/**
 * Normalize a URL-alias path for storage/comparison: trim, ensure a single
 * leading slash, drop a trailing slash (except root).
 * @param {*} value A raw alias.
 * @returns {?string} The normalized alias, or null when empty.
 */
function normalizeAlias(value) {
  if (value === undefined || value === null) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (!s.startsWith("/")) s = `/${s}`;
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}

/**
 * Resolve the `path` attribute to send on an alias-aware node write so the alias
 * actually persists, and decide whether a rename redirect is needed.
 *
 * The bug (DEV-116): JSON:API deserializes `{ alias, pathauto }` onto the node's
 * `path` field, dropping the existing alias's `pid`; Drupal's `PathItem::postSave`
 * then *creates a duplicate* `path_alias` (the older one stays canonical) instead
 * of updating in place. The fix is to round-trip the existing `pid` so the update
 * is in place. DEV-114's path-omitted "preserve" had the same defect (no `pid`),
 * so it is fixed here too.
 *
 * @param {object} args - { backend, type, id, providedPath, isCreate }.
 * @returns {Promise<{pathAttr: (object|undefined), redirect: ?object}>}
 *   `pathAttr` is the `path` value to send (or undefined to omit, letting pathauto
 *   run on create); `redirect` is `{ from, to, nid }` when a rename redirect is due.
 */
async function resolvePathWrite({ backend, type, id, providedPath, isCreate }) {
  const info = id
    ? await backend.getPathInfo({ entityType: "node", bundle: type, id }).catch(() => ({}))
    : {};
  const oldAlias = normalizeAlias(info.alias);
  const langcode = info.langcode || DEFAULT_ALIAS_LANGCODE;

  if (providedPath && typeof providedPath === "object") {
    // Explicit alias set/replace → manual alias, round-trip the existing pid so
    // Drupal updates in place rather than creating a duplicate.
    if (providedPath.alias) {
      const newAlias = normalizeAlias(providedPath.alias);
      const pathAttr = { alias: newAlias, pathauto: false, langcode };
      if (info.pid !== undefined && info.pid !== null) pathAttr.pid = info.pid;
      const redirect = !isCreate && oldAlias && oldAlias !== newAlias
        ? { from: oldAlias, to: newAlias, nid: info.drupalId }
        : null;
      return { pathAttr, redirect };
    }
    // Caller passed `path` without an alias (e.g. re-enabling pathauto) — respect it as-is.
    return { pathAttr: providedPath, redirect: null };
  }

  // No explicit path on update → preserve the current alias *with its pid* so the
  // save can neither revert nor duplicate it.
  if (!isCreate && oldAlias) {
    const pathAttr = { alias: oldAlias, pathauto: false, langcode };
    if (info.pid !== undefined && info.pid !== null) pathAttr.pid = info.pid;
    return { pathAttr, redirect: null };
  }

  // Create without an explicit path → omit it so pathauto generates the alias.
  return { pathAttr: undefined, redirect: null };
}

/**
 * Best-effort create a 301 redirect from a node's old alias to the node after a
 * rename, so the previous URL keeps resolving. Governed like any redirect write;
 * never fails the node update (failures are reported, not thrown). Idempotent:
 * skips when a redirect already exists for the source.
 *
 * @param {object} backend Resolved backend.
 * @param {object} sec Resolved security config.
 * @param {{from: string, to: string, nid: ?(number|string)}} redirect
 * @returns {Promise<object>} Outcome `{ created, ... }` for the response.
 */
async function createRenameRedirect(backend, sec, redirect) {
  try {
    assertWriteAllowed(sec, "create", REDIRECT_ENTITY_TYPE, REDIRECT_ENTITY_TYPE);
  } catch {
    return { created: false, reason: "redirect creation not permitted by policy", source: redirect.from };
  }
  // Prefer an alias-independent target so a future rename can't break the redirect.
  const target = redirect.nid !== undefined && redirect.nid !== null
    ? `entity:node/${redirect.nid}`
    : redirect.to;
  const sourceStored = redirect.from.replace(/^\/+/, "");
  try {
    const existing = await backend.listEntities({
      entityType: REDIRECT_ENTITY_TYPE, bundle: REDIRECT_ENTITY_TYPE,
      filters: [{ field: "redirect_source.path", op: "eq", value: sourceStored }],
      page: { limit: 1 },
    }).catch(() => null);
    if (existing?.entities?.length) {
      return { created: false, reason: "redirect already exists", source: redirect.from };
    }
    await backend.createEntity({
      entityType: REDIRECT_ENTITY_TYPE, bundle: REDIRECT_ENTITY_TYPE,
      attributes: buildRedirectAttributes(redirect.from, target, 301),
    });
    return { created: true, source: redirect.from, target };
  } catch (err) {
    return { created: false, reason: err?.message || String(err), source: redirect.from };
  }
}

/**
 * Build a Drupal body field descriptor from plain HTML + optional summary.
 *
 * @param {string} [body]    - Body HTML; when undefined the field is omitted.
 * @param {string} [summary] - Teaser/summary text.
 * @returns {{value: string, format: string, summary: string}|undefined}
 *   A body attribute object, or undefined when no body was supplied (so callers
 *   can skip the field on update rather than blanking it).
 */
function buildBodyAttribute(body, summary) {
  if (body === undefined) return undefined;
  return { value: body, format: "full_html", summary: summary ?? "" };
}

/**
 * Normalize limit/offset args into the backend's page descriptor.
 *
 * @param {{limit?: number, offset?: number}} args
 * @returns {{limit: number, offset: number}}
 */
function pageOf({ limit = 20, offset = 0 }) {
  return { limit, offset };
}

/**
 * Fetch a single node by type + UUID, redacted per the site policy.
 *
 * @param {object} args - { site?, type, id }.
 * @returns {Promise<object|null>} The redacted node, or null if not found.
 */
async function getNode({ site: siteName, type, id }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const entity = await backend.getEntity({ entityType: "node", bundle: type, id });
  return entity ? redactCanonicalEntity(entity, sec, "node") : null;
}

/**
 * List nodes of a content type with optional status filter, paging and sorting.
 *
 * @param {object} args - { site?, type, status?, filters?, limit?, offset?, sort? }.
 *   A `status` boolean is appended to `filters` as a status equality descriptor.
 * @returns {Promise<{total: number, approximate: boolean, offset: number,
 *   nextOffset: number, nodes: object[]}>} Paged, redacted node list.
 */
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

/**
 * Search nodes by title substring (defaults to the article bundle).
 *
 * @param {object} args - { site?, query, type?, status?, limit? }.
 * @returns {Promise<object[]>} Redacted matching nodes.
 */
async function searchContent({ site: siteName, query, type, status, limit = 10 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const filters = [{ field: "title", op: "contains", value: query }];
  if (status !== undefined) filters.push({ field: "status", op: "eq", value: status });
  const res = await backend.listEntities({ entityType: "node", bundle: type || "article", filters, sort: [{ field: "changed", dir: "desc" }], page: { limit } });
  return res.entities.map((e) => redactCanonicalEntity(e, sec, "node"));
}

/**
 * Create a node. Caller-supplied `fields` are spread into the attribute map;
 * title/status/moderation_state/body are layered on top so they win over any
 * same-named field.
 *
 * Publish state — two mutually exclusive paths:
 *   - `moderationState` (e.g. "draft"/"published"): for content types under a
 *     content_moderation workflow. When given, `moderation_state` is sent and
 *     `status` is omitted (moderated entities reject a direct `status` write).
 *   - `status` (boolean): for non-moderated types. Defaults to false (draft) so
 *     content is never auto-published. `moderationState` takes precedence.
 * If a moderated bundle still receives `status` (the safe default), the JSON:API
 * backend transparently retries without it — see jsonapi.js.
 *
 * Entity-reference fields (taxonomy, related content, media) must be passed in
 * `relationships` (JSON:API shape), not `fields`; Drupal rejects reference fields
 * sent as attributes (#115).
 *
 * @param {object} args - { site?, type, title, body?, summary?, status?, moderationState?, fields?, relationships? }.
 * @returns {Promise<object>} The created node descriptor from the backend.
 */
async function createNode({ site: siteName, type, title, body, summary, status, moderationState, fields = {}, relationships = {}, dryRun = false, returning = "full" }) {
  const site = getSiteConfig(siteName);
  const attributes = { title, ...fields };
  if (moderationState !== undefined) {
    attributes.moderation_state = moderationState;
  } else {
    attributes.status = status === undefined ? false : status;
  }
  const bodyAttr = buildBodyAttribute(body, summary);
  if (bodyAttr) attributes.body = bodyAttr;
  assertPublishAllowed(resolveSecurityConfig(site), attributes);
  if (dryRun) return { dryRun: true, operation: "create", entityType: "node", bundle: type, attributes, relationships };
  const backend = await resolveBackend(site);
  // Alias handling: an explicit `path.alias` is set as a manual alias; otherwise
  // `path` is omitted so pathauto generates the alias (DEV-116).
  const { pathAttr } = await resolvePathWrite({ backend, type, id: null, providedPath: attributes.path, isCreate: true });
  if (pathAttr === undefined) delete attributes.path;
  else attributes.path = pathAttr;
  const created = await backend.createEntity({ entityType: "node", bundle: type, attributes, relationships });
  // Honest response: re-read so the persisted alias (explicit or pathauto-generated)
  // is reflected rather than the pre-alias write response.
  const fresh = await backend.getEntity({ entityType: "node", bundle: type, id: created.id }).catch(() => null);
  return shapeWriteResponse(fresh ?? created, returning);
}

/**
 * Update a node. Only supplied attributes are sent, so omitted fields are left
 * untouched (partial update). `fields` is spread first, then known scalars.
 *
 * Publish state mirrors createNode: pass `moderationState` for content_moderation
 * bundles (sends `moderation_state`, omits `status`) or `status` for non-moderated
 * types. `moderationState` takes precedence; both are optional on update.
 *
 * Alias hardening: a partial update that doesn't touch `path` can still lose the
 * node's URL alias when a module (e.g. Pathauto, in automatic mode) regenerates
 * it on save. To preserve the existing alias, when the caller supplies no `path`
 * the current alias is read back and re-pinned (`{ alias, pathauto: 0 }`). Pass
 * `fields.path` explicitly to set/replace the alias yourself.
 *
 * Entity-reference fields go in `relationships` (JSON:API shape), not `fields` (#115).
 *
 * @param {object} args - { site?, type, id, title?, body?, summary?, status?, moderationState?, fields?, relationships? }.
 * @returns {Promise<object>} The updated node descriptor.
 */
async function updateNode({ site: siteName, type, id, title, body, summary, status, moderationState, fields = {}, relationships = {}, dryRun = false, returning = "full" }) {
  const site = getSiteConfig(siteName);
  const attributes = { ...fields };
  if (title !== undefined) attributes.title = title;
  if (moderationState !== undefined) attributes.moderation_state = moderationState;
  else if (status !== undefined) attributes.status = status;
  const bodyAttr = buildBodyAttribute(body, summary);
  if (bodyAttr) attributes.body = bodyAttr;
  assertPublishAllowed(resolveSecurityConfig(site), attributes);
  if (dryRun) return { dryRun: true, operation: "update", entityType: "node", bundle: type, id, attributes, relationships };
  const backend = await resolveBackend(site);
  const sec = resolveSecurityConfig(site);
  // Alias handling (DEV-116): an explicit `path.alias` is set in place by
  // round-tripping the existing alias's pid (no duplicate); a path-less update
  // re-pins the current alias *with its pid* so the save can't revert/duplicate
  // it. A rename (alias changed) also gets a 301 redirect from the old path.
  const { pathAttr, redirect } = await resolvePathWrite({ backend, type, id, providedPath: attributes.path, isCreate: false });
  if (pathAttr === undefined) delete attributes.path;
  else attributes.path = pathAttr;
  await backend.updateEntity({ entityType: "node", bundle: type, id, attributes, relationships });
  const redirectResult = redirect ? await createRenameRedirect(backend, sec, redirect) : null;
  // Honest response: re-read persisted state so the returned `url` is the alias
  // that actually resolves, never the just-sent value.
  const fresh = await backend.getEntity({ entityType: "node", bundle: type, id }).catch(() => null);
  if (fresh && redirectResult) return shapeWriteResponse({ ...fresh, _redirect: redirectResult }, returning);
  return shapeWriteResponse(fresh ?? { id }, returning);
}

/**
 * Permanently delete a node. The destructive-allowed assertion is applied
 * upstream by the security middleware in index.js.
 *
 * @param {object} args - { site?, type, id }.
 * @returns {Promise<{success: boolean, deletedId: string}>}
 */
async function deleteNode({ site: siteName, type, id, dryRun = false }) {
  const site = getSiteConfig(siteName);
  if (dryRun) return { dryRun: true, operation: "delete", entityType: "node", bundle: type, id };
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
    description: "Create a new content node. Returns the new node UUID, integer ID, and URL. For content types under an editorial (content_moderation) workflow, set moderationState (e.g. 'draft'/'published') instead of status. Entity-reference fields (taxonomy terms, related content, media) go in `relationships`, not `fields`.",
    inputSchema: {
      type: "object", required: ["type", "title"],
      properties: {
        site:    { type: "string" },
        type:    { type: "string", description: "Content type machine name" },
        title:   { type: "string" },
        body:    { type: "string", description: "Body field HTML" },
        summary: { type: "string", description: "Body summary / teaser" },
        status:  { type: "boolean", default: false, description: "Published flag for NON-moderated types. true to publish immediately. Ignored if moderationState is set; on a moderated type it is dropped automatically." },
        moderationState: { type: "string", description: "Moderation state for content_moderation types, e.g. 'draft' or 'published'. Takes precedence over status." },
        fields:  { type: "object", description: "Scalar/attribute field values keyed by Drupal machine name. Do NOT put entity-reference fields here — Drupal rejects them as attributes; use `relationships`." },
        relationships: { type: "object", description: "Entity-reference fields as JSON:API relationships, keyed by field machine name. Single-value: { field_resource_type: { data: { type: 'taxonomy_term--resource_type', id: '<uuid>' } } }. Multi-value: { field_tags: { data: [{ type: 'taxonomy_term--tags', id: '<uuid>' }] } }." },
        dryRun:  { type: "boolean", default: false, description: "Validate and return a preview of the write without committing." },
        returning: RETURNING_SCHEMA,
      },
    },
  },
  {
    name: "drupal_update_node",
    description: "Update an existing node. Only include fields you want to change. For moderated content types, use moderationState (e.g. 'published') rather than status. Entity-reference fields go in `relationships`, not `fields`.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site:    { type: "string" },
        type:    { type: "string" },
        id:      { type: "string", description: "Node UUID" },
        title:   { type: "string" },
        body:    { type: "string" },
        summary: { type: "string" },
        status:  { type: "boolean", description: "Published flag for NON-moderated types: true = publish, false = unpublish. Ignored if moderationState is set." },
        moderationState: { type: "string", description: "Moderation state transition for content_moderation types, e.g. 'draft', 'published', 'archived'. Takes precedence over status." },
        fields:  { type: "object", description: "Scalar/attribute field values keyed by machine name. Entity-reference fields go in `relationships`, not here." },
        relationships: { type: "object", description: "Entity-reference fields as JSON:API relationships, keyed by field machine name. Single-value uses { data: { type, id } }; multi-value uses { data: [{ type, id }, …] }." },
        dryRun:  { type: "boolean", default: false, description: "Validate and return a preview of the update without committing." },
        returning: RETURNING_SCHEMA,
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
        dryRun: { type: "boolean", default: false, description: "Validate and return a preview of the delete without committing." },
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
