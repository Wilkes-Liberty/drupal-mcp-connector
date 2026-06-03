/**
 * GraphQL schema introspection and the queryable SchemaMap.
 *
 * Single responsibility: introspect a site's GraphQL schema once and build a
 * lookup from Drupal entityType/bundle to the graphql_compose query fields
 * (single + collection), field names, and field type kinds. The resolved map
 * is cached per site so introspection runs at most once per process per site.
 */

import { drupalGraphqlFetch } from "../drupal-fetch.js";
import { graphqlTypeToEntity } from "./graphql-names.js";

// Introspection is intentionally nested four `ofType` levels deep: a field type
// can be wrapped as NON_NULL(LIST(NON_NULL(NamedType))), so four levels are
// needed to reach the underlying named type through every wrapper combination.
const INTROSPECTION_QUERY = `
{
  __schema {
    queryType { name }
    types {
      name
      kind
      enumValues { name }
      fields {
        name
        args { name }
        type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
      }
    }
  }
}`;

const cache = new Map();

/**
 * Test helper: clear the per-site schema cache.
 * @returns {void}
 */
export function _clearSchemaCache() {
  cache.clear();
}

/**
 * Unwrap NON_NULL/LIST wrappers down to the meaningful kind and type names.
 * @param {object|null} t An introspection type node.
 * @returns {{kind: ?string, typeName: ?string, ofTypeKind: ?string, ofTypeName: ?string}}
 *   For LIST types, `ofType*` describes the element type; otherwise `typeName`
 *   is the named type.
 */
function describeType(t) {
  // Returns { kind, typeName, ofTypeKind, ofTypeName }
  if (!t) return { kind: null, typeName: null, ofTypeKind: null, ofTypeName: null };
  if (t.kind === "NON_NULL") return describeType(t.ofType);
  if (t.kind === "LIST") {
    const inner = t.ofType?.kind === "NON_NULL" ? t.ofType.ofType : t.ofType;
    return { kind: "LIST", typeName: null, ofTypeKind: inner?.kind ?? null, ofTypeName: inner?.name ?? null };
  }
  return { kind: t.kind, typeName: t.name, ofTypeKind: null, ofTypeName: null };
}

/**
 * @typedef {Object} SchemaEntry
 * @property {string} typeName    graphql_compose object type, e.g. "NodeArticle".
 * @property {string} entityType  Drupal entity type, e.g. "node".
 * @property {string} bundle      Drupal bundle, e.g. "article".
 * @property {?string} single     Query field returning one entity, or null.
 * @property {?string} collection Query field returning a connection, or null.
 * @property {Map<string, object>} fields Field name -> describeType() result.
 */

/**
 * Resolved schema lookup: entityType/bundle -> SchemaEntry, plus the set of
 * server-supported sort-key enum values.
 */
class SchemaMap {
  constructor() {
    this._byEntity = new Map();   // "node:article" -> SchemaEntry
    this._typeToEntity = new Map(); // "NodeArticle" -> {entityType, bundle}
    /** @type {Set<string>} Enum values of ConnectionSortKeys (server-side sort). */
    this.sortKeys = new Set();
  }

  /**
   * Compose the internal map key for an entity/bundle pair.
   * @param {string} entityType
   * @param {string} bundle
   * @returns {string}
   */
  static _key(entityType, bundle) { return `${entityType}:${bundle}`; }

  /**
   * Look up the schema entry for an entity/bundle.
   * @param {string} entityType
   * @param {string} bundle
   * @returns {?SchemaEntry}
   */
  forEntity(entityType, bundle) {
    return this._byEntity.get(SchemaMap._key(entityType, bundle)) ?? null;
  }

  /**
   * Reverse lookup: GraphQL type name -> entity/bundle.
   * @param {string} typeName
   * @returns {{entityType: string, bundle: string}|null}
   */
  entityForType(typeName) {
    return this._typeToEntity.get(typeName) ?? null;
  }

  /**
   * List bundles of the `node` entity type.
   * @returns {string[]}
   */
  nodeBundles() {
    const out = [];
    for (const [key, v] of this._byEntity) {
      if (key.startsWith("node:")) out.push(v.bundle);
    }
    return out;
  }

  /**
   * List the bundles of a given entity type.
   * @param {string} entityType
   * @returns {string[]}
   */
  bundlesOf(entityType) {
    const out = [];
    const prefix = `${entityType}:`;
    for (const [key, v] of this._byEntity) {
      if (key.startsWith(prefix)) out.push(v.bundle);
    }
    return out;
  }

  /**
   * List every known entity/bundle pair.
   * @returns {Array<{entityType: string, bundle: string}>}
   */
  allEntities() {
    const out = [];
    for (const v of this._byEntity.values()) {
      out.push({ entityType: v.entityType, bundle: v.bundle });
    }
    return out;
  }
}

/**
 * Build a SchemaMap from a raw introspection response.
 * @param {object} introspection The `{ data: { __schema } }` response.
 * @returns {SchemaMap}
 */
function buildSchemaMap(introspection) {
  const schema = introspection.data.__schema;
  const typesByName = new Map(schema.types.map((t) => [t.name, t]));
  const queryType = typesByName.get(schema.queryType.name);
  const map = new SchemaMap();

  // Sort keys
  const sortEnum = typesByName.get("ConnectionSortKeys");
  for (const v of sortEnum?.enumValues ?? []) map.sortKeys.add(v.name);

  // Index single + collection fields by the concrete entity object type they expose.
  const singles = new Map();      // typeName -> queryField
  const collections = new Map();  // typeName -> queryField
  for (const f of queryType.fields ?? []) {
    const d = describeType(f.type);
    // graphql_compose names collection types <Entity>Connection; the nodes-type
    // guard below is sufficient, so we don't also require a pageInfo field here.
    if (d.kind === "OBJECT" && d.typeName?.endsWith("Connection")) {
      const conn = typesByName.get(d.typeName);
      const nodesField = conn?.fields?.find((x) => x.name === "nodes");
      const nodeType = describeType(nodesField?.type).ofTypeName;
      if (nodeType) collections.set(nodeType, f.name);
    } else if (d.kind === "OBJECT" && (f.args ?? []).some((a) => a.name === "id")) {
      singles.set(d.typeName, f.name);
    }
  }

  // For each entity object type with a single OR collection field, build the entry.
  const typeNames = new Set([...singles.keys(), ...collections.keys()]);
  for (const typeName of typeNames) {
    const entity = graphqlTypeToEntity(typeName);
    if (!entity) continue;
    const typeDef = typesByName.get(typeName);
    const fields = new Map();
    for (const ff of typeDef?.fields ?? []) {
      fields.set(ff.name, describeType(ff.type));
    }
    const entry = {
      typeName,
      entityType: entity.entityType,
      bundle: entity.bundle,
      single: singles.get(typeName) ?? null,
      collection: collections.get(typeName) ?? null,
      fields,
    };
    map._byEntity.set(SchemaMap._key(entity.entityType, entity.bundle), entry);
    map._typeToEntity.set(typeName, { entityType: entity.entityType, bundle: entity.bundle });
  }

  return map;
}

/**
 * Load (or return the cached) SchemaMap for a site.
 * @param {object} site Site config; must include `_name` (the cache key).
 * @returns {Promise<SchemaMap>}
 * @throws {Error} When introspection fails (the cache entry is cleared first).
 */
export async function loadSchemaMap(site) {
  // Cache the in-flight Promise (not the resolved value) so concurrent first
  // calls share a single introspection. Clear on failure so a transient error
  // does not poison the cache.
  if (!cache.has(site._name)) {
    const pending = drupalGraphqlFetch(site, { query: INTROSPECTION_QUERY })
      .then(buildSchemaMap)
      .catch((err) => {
        cache.delete(site._name);
        throw err;
      });
    cache.set(site._name, pending);
  }
  return cache.get(site._name);
}
