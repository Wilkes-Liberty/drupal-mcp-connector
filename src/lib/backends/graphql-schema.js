/**
 * GraphQL schema introspection + a queryable map from Drupal entityType/bundle
 * to graphql_compose field names and field type kinds. Cached per site.
 */

import { drupalGraphqlFetch } from "../drupal-fetch.js";
import { graphqlTypeToEntity } from "./graphql-names.js";

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

/** Test helper: clear the per-site schema cache. */
export function _clearSchemaCache() {
  cache.clear();
}

/** Unwrap NON_NULL/LIST wrappers to the meaningful kind + names. */
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

class SchemaMap {
  constructor() {
    this._byEntity = new Map();   // "node:article" -> {typeName, single, collection, fields:Map}
    this._typeToEntity = new Map(); // "NodeArticle" -> {entityType, bundle}
    this.sortKeys = new Set();
  }

  static _key(entityType, bundle) { return `${entityType}:${bundle}`; }

  forEntity(entityType, bundle) {
    return this._byEntity.get(SchemaMap._key(entityType, bundle)) ?? null;
  }

  entityForType(typeName) {
    return this._typeToEntity.get(typeName) ?? null;
  }

  nodeBundles() {
    const out = [];
    for (const [key, v] of this._byEntity) {
      if (key.startsWith("node:")) out.push(v.bundle);
    }
    return out;
  }

  bundlesOf(entityType) {
    const out = [];
    const prefix = `${entityType}:`;
    for (const [key, v] of this._byEntity) {
      if (key.startsWith(prefix)) out.push(v.bundle);
    }
    return out;
  }

  allEntities() {
    const out = [];
    for (const v of this._byEntity.values()) {
      out.push({ entityType: v.entityType, bundle: v.bundle });
    }
    return out;
  }
}

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
 * Load (or return cached) SchemaMap for a site.
 * @returns {Promise<SchemaMap>}
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
