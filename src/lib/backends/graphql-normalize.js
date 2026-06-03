/**
 * GraphQL result normalization.
 *
 * Single responsibility: convert a graphql_compose node object into the
 * shared CanonicalEntity shape, promoting base fields, collapsing entity
 * references into canonical relationship refs, and leaving everything else as
 * raw field values.
 */

import { makeCanonicalEntity } from "../canonical.js";
import { graphqlTypeToEntity } from "./graphql-names.js";

// Node keys that map to canonical base properties, not to `fields`.
const BASE_KEYS = new Set(["__typename", "id", "title", "status", "langcode", "created", "changed", "path"]);

/**
 * Detect a single entity reference object (has `__typename` and `id`).
 * @param {*} v Candidate value.
 * @returns {boolean}
 */
function isEntityRef(v) {
  return v && typeof v === "object" && typeof v.__typename === "string" && "id" in v;
}

/**
 * Collapse an entity-reference object into a canonical relationship ref.
 * @param {{__typename: string, id: string}} v
 * @returns {{id: string, entityType: ?string, bundle: ?string}}
 */
function refToCanonical(v) {
  const entity = graphqlTypeToEntity(v.__typename) ?? { entityType: null, bundle: null };
  return { id: v.id, entityType: entity.entityType, bundle: entity.bundle };
}

/**
 * Normalize a graphql_compose node into a CanonicalEntity.
 * @param {object} node Raw GraphQL node object (includes `__typename`, `id`).
 * @returns {import("../canonical.js").CanonicalEntity}
 */
export function graphqlNodeToCanonical(node) {
  const entity = graphqlTypeToEntity(node.__typename || "") ?? { entityType: null, bundle: null };

  const fieldsMap = new Map();
  const relationshipsMap = new Map();
  for (const [k, v] of Object.entries(node)) {
    if (BASE_KEYS.has(k)) continue;
    if (isEntityRef(v)) {
      relationshipsMap.set(k, refToCanonical(v));
    } else if (Array.isArray(v) && v.length && v.every(isEntityRef)) {
      relationshipsMap.set(k, v.map(refToCanonical));
    } else {
      // Note: an empty array ([]) lands in `fields`, not `relationships` — we
      // cannot tell an empty multi-ref from an empty scalar list without schema
      // context, so empties stay as raw field values.
      fieldsMap.set(k, v);
    }
  }

  return makeCanonicalEntity({
    id: node.id,
    entityType: entity.entityType,
    bundle: entity.bundle,
    title: node.title ?? null,
    status: typeof node.status === "boolean" ? node.status : (node.status ?? null),
    langcode: node.langcode?.id ?? null,
    created: node.created?.time ?? null,
    changed: node.changed?.time ?? null,
    url: node.path ?? null,
    fields: Object.fromEntries(fieldsMap),
    relationships: Object.fromEntries(relationshipsMap),
    backend: "graphql",
  });
}
