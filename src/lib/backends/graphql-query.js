/**
 * GraphQL selection-set and query-document builders for graphql_compose.
 *
 * Single responsibility: turn a resolved SchemaEntry into a valid GraphQL
 * query string. The builders are type-aware so the generated selection only
 * requests fields the server can actually resolve (scalars are selected bare,
 * scalar-wrapper objects get a fixed sub-selection, entity references collapse
 * to `{ __typename id }`, and unknown wrappers are skipped to keep the query
 * valid).
 */

import { graphqlTypeToEntity } from "./graphql-names.js";

// graphql_compose wraps some scalars in object types; each needs an explicit
// sub-selection because GraphQL forbids selecting an object without one.
const OBJECT_SUBSELECTIONS = new Map([
  ["DateTime", "{ time }"],
  ["Language", "{ id }"],
  ["TextSummary", "{ value summary format }"],
]);

// Field kinds that are selected as a bare field name (no sub-selection).
const SCALAR_KINDS = new Set(["SCALAR", "ENUM"]);

/**
 * Map an entity union type name to its companion `<Entity>Interface`.
 * An entity union/interface (TermUnion, MediaUnion, ...) exposes a matching
 * <Entity>Interface with an `id`. Non-entity unions (e.g. MetaTagUnion) do
 * NOT, so an inline fragment on their "interface" would be invalid — return
 * null so the caller skips them.
 * @param {?string} unionTypeName e.g. "MediaUnion".
 * @returns {?string} e.g. "MediaInterface", or null when not an entity union.
 */
function entityInterfaceFor(unionTypeName) {
  if (!unionTypeName || !graphqlTypeToEntity(unionTypeName)) return null;
  return unionTypeName.replace(/Union$/, "Interface");
}

/**
 * Build the selection text for a single field, or null to skip it.
 * @param {string} name Field name.
 * @param {object} desc describeType() result for the field.
 * @returns {?string} Selection fragment, or null when the field is unselectable.
 */
function selectField(name, desc) {
  if (SCALAR_KINDS.has(desc.kind)) return name;

  if (desc.kind === "OBJECT") {
    const sub = OBJECT_SUBSELECTIONS.get(desc.typeName);
    if (sub) return `${name} ${sub}`;
    // Another entity (User, MediaImage, ...) -> relationship reference.
    if (graphqlTypeToEntity(desc.typeName)) return `${name} { __typename id }`;
    return null; // unknown object wrapper -> skip to keep the query valid
  }

  // Single union/interface field (e.g. heroImage: MediaUnion) -> entity ref.
  if (desc.kind === "UNION" || desc.kind === "INTERFACE") {
    const iface = entityInterfaceFor(desc.typeName);
    return iface ? `${name} { __typename ... on ${iface} { __typename id } }` : null;
  }

  if (desc.kind === "LIST") {
    if (desc.ofTypeKind === "UNION" || desc.ofTypeKind === "INTERFACE") {
      const iface = entityInterfaceFor(desc.ofTypeName);
      return iface ? `${name} { __typename ... on ${iface} { __typename id } }` : null;
    }
    if (desc.ofTypeKind === "OBJECT" && graphqlTypeToEntity(desc.ofTypeName)) {
      return `${name} { __typename id }`;
    }
    if (SCALAR_KINDS.has(desc.ofTypeKind)) return name;
    return null;
  }

  return null;
}

/**
 * Build the selection set (without surrounding braces) for an entity entry.
 * Always includes `__typename` and `id` so results can be normalized later.
 * @param {import("./graphql-schema.js").SchemaEntry} entry
 * @returns {string} Space-joined selection fragments.
 */
export function buildSelection(entry) {
  const parts = ["__typename"];
  for (const [name, desc] of entry.fields) {
    if (name === "__typename") continue;
    const sel = selectField(name, desc);
    if (sel && sel !== "__typename") parts.push(sel);
  }
  // Ensure id present even if not in fields map.
  if (!parts.some((p) => p === "id" || p.startsWith("id "))) parts.splice(1, 0, "id");
  return parts.join(" ");
}

/**
 * Render collection arguments into GraphQL argument syntax.
 * @param {{first?: number, after?: string, sortKey?: string, reverse?: boolean}} args
 * @returns {string} e.g. "(first: 50, sortKey: CREATED_AT)" or "" when empty.
 */
function formatArgs(args) {
  const out = [];
  if (args.first !== undefined && args.first !== null) out.push(`first: ${args.first}`);
  if (args.after) out.push(`after: ${JSON.stringify(args.after)}`);
  if (args.sortKey) out.push(`sortKey: ${args.sortKey}`);
  if (args.reverse !== undefined) out.push(`reverse: ${args.reverse}`);
  return out.length ? `(${out.join(", ")})` : "";
}

/**
 * Build a collection (connection) query document.
 * @param {import("./graphql-schema.js").SchemaEntry} entry
 * @param {{first?: number, after?: string, sortKey?: string, reverse?: boolean}} [args]
 * @returns {string} A complete GraphQL query string.
 */
export function buildCollectionQuery(entry, args = {}) {
  const selection = buildSelection(entry);
  return `{ ${entry.collection}${formatArgs(args)} { pageInfo { hasNextPage endCursor } nodes { ${selection} } } }`;
}

/**
 * Build a single-entity query document.
 * @param {import("./graphql-schema.js").SchemaEntry} entry
 * @param {string} id Entity id (UUID) to fetch.
 * @returns {string} A complete GraphQL query string.
 */
export function buildSingleQuery(entry, id) {
  const selection = buildSelection(entry);
  return `{ ${entry.single}(id: ${JSON.stringify(id)}) { ${selection} } }`;
}
