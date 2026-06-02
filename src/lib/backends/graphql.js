/**
 * Read-only GraphQL backend over graphql_compose. Returns canonical entities.
 * Writes are capability-gated (throw). Filters/unsupported sorts run client-side
 * with bounded pagination.
 */

import { drupalGraphqlFetch } from "../drupal-fetch.js";
import { Backend } from "./backend-interface.js";
import { BackendCapabilityError } from "./errors.js";
import { loadSchemaMap } from "./graphql-schema.js";
import { buildCollectionQuery, buildSingleQuery } from "./graphql-query.js";
import { graphqlNodeToCanonical } from "./graphql-normalize.js";
import { applyClientFilters, applyClientSort } from "./graphql-filter.js";
import { graphqlTypeToEntity } from "./graphql-names.js";

const MAX_CLIENT_RECORDS = 1000;
const DEFAULT_PAGE = 50;

const SORT_KEY_MAP = new Map([
  ["created", "CREATED_AT"],
  ["changed", "UPDATED_AT"],
  ["title", "TITLE"],
]);

/**
 * Safe dynamic-key lookup that avoids security/detect-object-injection.
 * Returns undefined when obj is null/undefined or key is absent.
 */
function pick(obj, key) {
  if (obj === null || obj === undefined) return undefined;
  return new Map(Object.entries(obj)).get(key);
}

export class GraphqlBackend extends Backend {
  constructor(site) {
    super();
    this.site = site;
  }

  capabilities() {
    return {
      read: true, write: false, delete: false,
      count: false, filter: false, sort: "enum", revisions: false,
      fieldAvailability: (entityType, bundle) => this._fieldNames(entityType, bundle),
    };
  }

  async _map() {
    return loadSchemaMap(this.site);
  }

  async _fieldNames(entityType, bundle) {
    const map = await this._map();
    const entry = map.forEntity(entityType, bundle);
    return entry ? [...entry.fields.keys()] : [];
  }

  _nativeSortKey(map, sort) {
    if (!sort || sort.length !== 1) return null;
    const key = SORT_KEY_MAP.get(sort[0].field);
    if (key && map.sortKeys.has(key)) return { sortKey: key, reverse: sort[0].dir === "desc" };
    return null;
  }

  async _requireEntry(entityType, bundle) {
    const map = await this._map();
    const entry = map.forEntity(entityType, bundle);
    if (!entry || !entry.collection) {
      throw new BackendCapabilityError(
        `GraphQL backend has no queryable type for "${entityType}/${bundle}" on site "${this.site._name}".`
      );
    }
    return { map, entry };
  }

  // GraphQL reports query errors as HTTP 200 with an `errors` array; throw on
  // them so a backend failure surfaces as an error, not a silently-empty result.
  async _query(query) {
    const json = await drupalGraphqlFetch(this.site, { query });
    if (json?.errors?.length) {
      throw new Error(
        `GraphQL query failed on site "${this.site._name}": ` +
        json.errors.map((e) => e.message).join("; ")
      );
    }
    return json;
  }

  async _fetchPage(entry, args) {
    const query = buildCollectionQuery(entry, args);
    const json = await this._query(query);
    const conn = pick(json.data, entry.collection);
    return {
      nodes: conn?.nodes ?? [],
      hasNext: Boolean(conn?.pageInfo?.hasNextPage),
      cursor: conn?.pageInfo?.endCursor ?? null,
    };
  }

  async listEntities(descriptor) {
    const { entityType, bundle, filters = [], sort = [], page = {} } = descriptor;
    const { map, entry } = await this._requireEntry(entityType, bundle);
    const limit = page.limit ?? DEFAULT_PAGE;

    const native = this._nativeSortKey(map, sort);
    const needsClient = filters.length > 0 || (sort.length > 0 && !native);

    if (!needsClient) {
      const offset = page.offset ?? 0;
      const pageData = await this._fetchPage(entry, { first: offset + limit, ...(native ? { sortKey: native.sortKey, reverse: native.reverse } : {}) });
      const all = pageData.nodes.map(graphqlNodeToCanonical);
      const window = all.slice(offset, offset + limit);
      return {
        entities: window,
        page: { total: null, hasNext: pageData.hasNext || all.length > offset + limit, cursor: pageData.cursor },
        approximate: false,
        truncated: false,
      };
    }

    // Client-side path: paginate up to the cap, then filter/sort/slice.
    const collected = [];
    let after = null;
    let truncated = false;
    const sortArgs = native ? { sortKey: native.sortKey, reverse: native.reverse } : {};
    for (;;) {
      const remaining = MAX_CLIENT_RECORDS - collected.length;
      if (remaining <= 0) { truncated = true; break; }
      const pageData = await this._fetchPage(entry, { first: Math.min(100, remaining), after, ...sortArgs });
      collected.push(...pageData.nodes.map(graphqlNodeToCanonical));
      if (!pageData.hasNext) break;
      if (!pageData.cursor) break; // server bug guard: hasNext:true but no cursor — stop rather than spin
      after = pageData.cursor;
    }

    let result = applyClientFilters(collected, filters);
    if (sort.length && !native) result = applyClientSort(result, sort);
    const offset = page.offset ?? 0;
    const sliced = result.slice(offset, offset + limit);
    return {
      entities: sliced,
      page: { total: result.length, hasNext: result.length > offset + limit, cursor: null },
      approximate: true,
      truncated,
    };
  }

  async getEntity({ entityType, bundle, id }) {
    const { entry } = await this._requireEntry(entityType, bundle);
    const query = buildSingleQuery(entry, id);
    const json = await this._query(query);
    const node = pick(json.data, entry.single);
    return node ? graphqlNodeToCanonical(node) : null;
  }

  async createEntity() { return this._noWrite("create"); }
  async updateEntity() { return this._noWrite("update"); }
  async deleteEntity() { return this._noWrite("delete"); }

  _noWrite(op) {
    throw new BackendCapabilityError(
      `The GraphQL backend for site "${this.site._name}" is read-only; "${op}" is not supported. ` +
      "Use a JSON:API site for writes."
    );
  }

  async introspect() {
    const map = await this._map();
    const resourceTypes = [];
    for (const bundle of map.nodeBundles()) resourceTypes.push(`node--${bundle}`);
    return { resourceTypes };
  }

  async listContentTypes() {
    const map = await this._map();
    return map.nodeBundles().map((bundle) => ({ id: bundle, label: bundle, description: null }));
  }

  async listBundles(entityType) {
    const map = await this._map();
    return map.bundlesOf(entityType).map((bundle) => ({ id: bundle, label: bundle, description: null }));
  }

  async listRoles() {
    throw new BackendCapabilityError(
      `Listing user roles is not available over the GraphQL backend for site "${this.site._name}". ` +
      "Use a JSON:API site to enumerate roles."
    );
  }

  async uploadFile() {
    throw new BackendCapabilityError(
      `File upload is not available over the GraphQL backend for site "${this.site._name}". ` +
      "Use a JSON:API site to upload files."
    );
  }

  async countEntities(descriptor) {
    const res = await this.listEntities({ ...descriptor, page: { limit: MAX_CLIENT_RECORDS } });
    // GraphQL has no exact server count; the bounded result count is approximate.
    return { count: res.entities.length, approximate: true };
  }

  async listResourceTypes() {
    const map = await this._map();
    return map.allEntities().map(({ entityType, bundle }) => ({
      resourceType: `${entityType}--${bundle}`, entityType, bundle,
    }));
  }

  async getEntitySchema(entityType, bundle) {
    const { entry } = await this._requireEntry(entityType, bundle);
    const attrPairs = [];
    const relPairs = [];
    for (const [name, desc] of entry.fields) {
      const isUnionList = desc.kind === "LIST" && (desc.ofTypeKind === "UNION" || desc.ofTypeKind === "INTERFACE");
      const isEntityObj = desc.kind === "OBJECT" && graphqlTypeToEntity(desc.typeName) && !["DateTime", "Language", "TextSummary", "Text"].includes(desc.typeName);
      const isUnion = desc.kind === "UNION" || desc.kind === "INTERFACE";
      if (isUnionList || isEntityObj || isUnion) {
        relPairs.push([name, "relationship"]);
      } else {
        attrPairs.push([name, desc.typeName || desc.ofTypeName || desc.kind]);
      }
    }
    return {
      entityType, bundle, resourceType: `${entityType}--${bundle}`,
      attributes: Object.fromEntries(attrPairs),
      relationships: Object.fromEntries(relPairs),
    };
  }

  async rawQuery({ query, variables, operationName }) {
    return drupalGraphqlFetch(this.site, { query, variables, operationName });
  }

  async resolveFieldName(entityType, bundle, candidates) {
    const map = await this._map();
    const entry = map.forEntity(entityType, bundle);
    if (!entry) return null;
    return candidates.find((c) => entry.fields.has(c)) ?? null;
  }
}
