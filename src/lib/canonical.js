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

/**
 * Whether a field value is a JSON:API relationship linkage (`{ data: ... }`
 * where data is null, one `{ type, id }` reference, or an array of them —
 * an empty array clears a multi-value reference).
 *
 * Composite attribute values (e.g. `{ value, format }` text fields) have no
 * `data` key and are never matched, so ordinary attributes pass through.
 *
 * @param {*} value A caller-supplied field value.
 * @returns {boolean} True when the value is relationship-shaped.
 */
export function isRelationshipLinkage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, "data")) return false;
  const isRef = (d) => Boolean(d) && typeof d === "object" && !Array.isArray(d)
    && typeof d.type === "string" && typeof d.id === "string";
  const { data } = value;
  if (data === null) return true;
  if (Array.isArray(data)) return data.every(isRef);
  return isRef(data);
}

/**
 * Split a caller field map into JSON:API attributes and relationships (#171).
 *
 * Entity-reference values passed under a `fields` map used to be forwarded as
 * attributes, which Drupal rejects with a 422 ("relationship fields were
 * provided as attributes"). Relationship-shaped values are routed to the
 * `relationships` document member instead, so field-map tools accept the same
 * reference shape as `drupal_entity_update`.
 *
 * @param {object} fields Caller-supplied field map.
 * @returns {{attributes: object, relationships: ?object}} Split maps;
 *   `relationships` is null when no value was relationship-shaped.
 */
export function splitReferenceFields(fields) {
  const attrEntries = [];
  const relEntries = [];
  for (const entry of Object.entries(fields)) {
    const [, value] = entry;
    (isRelationshipLinkage(value) ? relEntries : attrEntries).push(entry);
  }
  return {
    attributes: Object.fromEntries(attrEntries),
    relationships: relEntries.length ? Object.fromEntries(relEntries) : null,
  };
}
