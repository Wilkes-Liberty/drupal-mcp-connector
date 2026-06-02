/**
 * Type-aware GraphQL selection-set and query-document builders for graphql_compose.
 */

import { graphqlTypeToEntity } from "./graphql-names.js";

// Known scalar-wrapper object types and the sub-selection to use for each.
const OBJECT_SUBSELECTIONS = new Map([
  ["DateTime", "{ time }"],
  ["Language", "{ id }"],
  ["TextSummary", "{ value summary format }"],
]);

const SCALAR_KINDS = new Set(["SCALAR", "ENUM"]);

// An entity union/interface (TermUnion, MediaUnion, ...) exposes a matching
// <Entity>Interface with an `id`. Non-entity unions (e.g. MetaTagUnion) do NOT,
// so an inline fragment on their "interface" is invalid — we must skip them.
function entityInterfaceFor(unionTypeName) {
  if (!unionTypeName || !graphqlTypeToEntity(unionTypeName)) return null;
  return unionTypeName.replace(/Union$/, "Interface");
}

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

/** Build the selection set (without surrounding braces) for an entity entry. */
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

function formatArgs(args) {
  const out = [];
  if (args.first !== undefined && args.first !== null) out.push(`first: ${args.first}`);
  if (args.after) out.push(`after: ${JSON.stringify(args.after)}`);
  if (args.sortKey) out.push(`sortKey: ${args.sortKey}`);
  if (args.reverse !== undefined) out.push(`reverse: ${args.reverse}`);
  return out.length ? `(${out.join(", ")})` : "";
}

/** Build a collection query document. */
export function buildCollectionQuery(entry, args = {}) {
  const selection = buildSelection(entry);
  return `{ ${entry.collection}${formatArgs(args)} { pageInfo { hasNextPage endCursor } nodes { ${selection} } } }`;
}

/** Build a single-entity query document. */
export function buildSingleQuery(entry, id) {
  const selection = buildSelection(entry);
  return `{ ${entry.single}(id: ${JSON.stringify(id)}) { ${selection} } }`;
}
