/**
 * Canonical, API-neutral entity model shared by all backends.
 *
 * Every tool returns this shape regardless of whether the data came from
 * JSON:API or GraphQL, so downstream consumers (reports, prompts, MCP clients)
 * never branch on the underlying protocol.
 *
 * @typedef {Object} CanonicalEntity
 * @property {string}  id            UUID
 * @property {string}  entityType    e.g. "node"
 * @property {string}  bundle        e.g. "article"
 * @property {?string} title
 * @property {?boolean} status
 * @property {?string} langcode
 * @property {?string} created       ISO-8601
 * @property {?string} changed       ISO-8601
 * @property {?string} url           path/alias
 * @property {Object}  fields        non-base fields
 * @property {Object}  relationships normalized refs ({id, entityType, bundle})
 * @property {string}  _backend      "jsonapi" | "graphql"
 *
 * @typedef {Object} QueryDescriptor
 * @property {string} entityType
 * @property {string} bundle
 * @property {Array<{field:string, op:string, value:*}>} [filters]
 * @property {Array<{field:string, dir:"asc"|"desc"}>}   [sort]
 * @property {string[]} [fields]
 * @property {string[]} [include]
 * @property {{limit?:number, offset?:number}} [page]
 */

/** Attribute names promoted out of `fields` into canonical base properties. */
export const BASE_ATTRIBUTE_FIELDS = ["title", "status", "langcode", "created", "changed", "path"];

/**
 * Build a canonical entity, filling defaults for any omitted optional props.
 * @param {object} parts Source values; id/entityType/bundle required, rest optional.
 * @param {string} parts.backend Backend tag stored as `_backend` ("jsonapi" | "graphql").
 * @returns {CanonicalEntity}
 */
export function makeCanonicalEntity(parts) {
  const {
    id, entityType, bundle,
    title = null, status = null, langcode = null,
    created = null, changed = null, url = null,
    fields = {}, relationships = {}, backend,
  } = parts;
  return {
    id, entityType, bundle,
    title, status, langcode, created, changed, url,
    fields, relationships,
    _backend: backend,
  };
}

/**
 * Normalize a JSON:API-style relationship reference (or array of them) into
 * canonical `{ id, entityType, bundle }`.
 * @param {?(object|object[])} ref A `{ id, type }` ref, an array of them, or null.
 * @returns {?(object|object[])} Normalized ref(s), or null when ref is falsy.
 */
export function normalizeRelationship(ref) {
  if (!ref) return null;
  if (Array.isArray(ref)) return ref.map(normalizeRelationship);
  // JSON:API encodes type as "entityType--bundle"; split into the two parts.
  const [entityType = null, bundle = null] = (ref.type || "").split("--");
  return { id: ref.id, entityType, bundle };
}
