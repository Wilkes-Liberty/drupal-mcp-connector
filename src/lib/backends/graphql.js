/**
 * Read-only GraphQL backend adapter over graphql_compose.
 *
 * Single responsibility: implement the Backend interface against a
 * graphql_compose schema, returning the shared CanonicalEntity shape. This
 * backend is read-only — create/update/delete are capability-gated and throw
 * BackendCapabilityError. Because graphql_compose offers no server-side field
 * filtering and only a fixed enum of sort keys, arbitrary filters and
 * non-native sorts are evaluated client-side over a bounded page set, and the
 * results are flagged `approximate`/`truncated` so callers know totals/paging
 * are best-effort.
 */

import { drupalGraphqlFetch } from "../drupal-fetch.js";
import { Backend } from "./backend-interface.js";
import { BackendCapabilityError } from "./errors.js";
import { loadSchemaMap } from "./graphql-schema.js";
import { buildCollectionQuery, buildSingleQuery } from "./graphql-query.js";
import { graphqlNodeToCanonical } from "./graphql-normalize.js";
import { applyClientFilters, applyClientSort } from "./graphql-filter.js";
import { graphqlTypeToEntity } from "./graphql-names.js";

// Upper bound on records pulled into memory for the client-side filter/sort
// path; caps cost and flags results `truncated` when exceeded.
const MAX_CLIENT_RECORDS = 1000;
// Page size used when the caller does not specify one.
const DEFAULT_PAGE = 50;
// Per-request fetch cap when collecting pages for the client-side path.
const CLIENT_FETCH_BATCH = 100;

// Canonical sort field -> graphql_compose ConnectionSortKeys enum value. Only
// these map to a native (server-side) sort; anything else falls back to client.
const SORT_KEY_MAP = new Map([
  ["created", "CREATED_AT"],
  ["changed", "UPDATED_AT"],
  ["title", "TITLE"],
]);

/**
 * Safe dynamic-key lookup that avoids security/detect-object-injection.
 * @param {object|null|undefined} obj Source object.
 * @param {string} key Property name to read.
 * @returns {*} The value, or undefined when obj is null/undefined or key absent.
 */
function pick(obj, key) {
  if (obj === null || obj === undefined) return undefined;
  return new Map(Object.entries(obj)).get(key);
}

/**
 * Read-only Backend adapter backed by a graphql_compose schema.
 */
export class GraphqlBackend extends Backend {
  /** @param {object} site Site config (must include `_name`). */
  constructor(site) {
    super();
    this.site = site;
  }

  /**
   * Report capabilities: read-only, no count/filter, enum-only sort.
   * @returns {import("./backend-interface.js").Capabilities}
   */
  capabilities() {
    return {
      read: true, write: false, delete: false,
      count: false, filter: false, sort: "enum", revisions: false,
      fieldAvailability: (entityType, bundle) => this._fieldNames(entityType, bundle),
    };
  }

  /**
   * Load (cached) the site's SchemaMap.
   * @returns {Promise<import("./graphql-schema.js").SchemaMap>}
   */
  async _map() {
    return loadSchemaMap(this.site);
  }

  /**
   * List the known field names for a bundle.
   * @param {string} entityType
   * @param {string} bundle
   * @returns {Promise<string[]>} Field names, or [] when the bundle is unknown.
   */
  async _fieldNames(entityType, bundle) {
    const map = await this._map();
    const entry = map.forEntity(entityType, bundle);
    return entry ? [...entry.fields.keys()] : [];
  }

  /**
   * Resolve a request into native sort args, when possible.
   * Only a single sort on a server-supported key qualifies; multi-key or
   * unsupported sorts return null so the caller falls back to client-side sort.
   * @param {import("./graphql-schema.js").SchemaMap} map
   * @param {Array<{field: string, dir?: "asc"|"desc"}>} sort
   * @returns {{sortKey: string, reverse: boolean}|null}
   */
  _nativeSortKey(map, sort) {
    if (!sort || sort.length !== 1) return null;
    const key = SORT_KEY_MAP.get(sort[0].field);
    if (key && map.sortKeys.has(key)) return { sortKey: key, reverse: sort[0].dir === "desc" };
    return null;
  }

  /**
   * Resolve a queryable schema entry for an entity/bundle, or throw.
   * @param {string} entityType
   * @param {string} bundle
   * @returns {Promise<{map: import("./graphql-schema.js").SchemaMap, entry: import("./graphql-schema.js").SchemaEntry}>}
   * @throws {BackendCapabilityError} When no queryable collection type exists.
   */
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

  /**
   * Run a GraphQL query and surface server errors as thrown errors.
   * GraphQL reports query errors as HTTP 200 with an `errors` array; throw on
   * them so a backend failure surfaces as an error, not a silently-empty result.
   * @param {string} query GraphQL query document.
   * @returns {Promise<object>} The raw `{ data, errors? }` response.
   * @throws {Error} When the response contains GraphQL errors.
   */
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

  /**
   * Fetch one page of a collection.
   * @param {import("./graphql-schema.js").SchemaEntry} entry
   * @param {{first?: number, after?: string, sortKey?: string, reverse?: boolean}} args
   * @returns {Promise<{nodes: object[], hasNext: boolean, cursor: ?string}>}
   */
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

  /**
   * List entities for a descriptor, using native paging/sort when the schema
   * supports it and falling back to a bounded client-side filter/sort path
   * otherwise.
   * @param {import("../canonical.js").QueryDescriptor} descriptor
   * @returns {Promise<import("./backend-interface.js").ListResult>} When the
   *   client-side path runs, `page.total` reflects the bounded set and the
   *   result is flagged `approximate` (and `truncated` if the cap was hit).
   */
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
      const pageData = await this._fetchPage(entry, { first: Math.min(CLIENT_FETCH_BATCH, remaining), after, ...sortArgs });
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

  /**
   * Fetch a single entity by id.
   * @param {{entityType: string, bundle: string, id: string}} ref
   * @returns {Promise<?import("../canonical.js").CanonicalEntity>} Entity, or null.
   * @throws {BackendCapabilityError} When the bundle is not queryable.
   */
  async getEntity({ entityType, bundle, id }) {
    const { entry } = await this._requireEntry(entityType, bundle);
    const query = buildSingleQuery(entry, id);
    const json = await this._query(query);
    const node = pick(json.data, entry.single);
    return node ? graphqlNodeToCanonical(node) : null;
  }

  /**
   * @returns {Promise<never>}
   * @throws {BackendCapabilityError} Always — this backend is read-only.
   */
  async createEntity() { return this._noWrite("create"); }
  /**
   * @returns {Promise<never>}
   * @throws {BackendCapabilityError} Always — this backend is read-only.
   */
  async updateEntity() { return this._noWrite("update"); }
  /**
   * @returns {Promise<never>}
   * @throws {BackendCapabilityError} Always — this backend is read-only.
   */
  async deleteEntity() { return this._noWrite("delete"); }

  /**
   * Throw the uniform read-only error for a write operation.
   * @param {string} op Operation name for the message.
   * @returns {never}
   * @throws {BackendCapabilityError} Always.
   */
  _noWrite(op) {
    throw new BackendCapabilityError(
      `The GraphQL backend for site "${this.site._name}" is read-only; "${op}" is not supported. ` +
      "Use a JSON:API site for writes."
    );
  }

  /**
   * Discover queryable node resource types.
   * @returns {Promise<{resourceTypes: string[]}>} `node--<bundle>` identifiers.
   */
  async introspect() {
    const map = await this._map();
    const resourceTypes = [];
    for (const bundle of map.nodeBundles()) resourceTypes.push(`node--${bundle}`);
    return { resourceTypes };
  }

  /**
   * List node content types. GraphQL exposes no human label/description, so
   * `label` mirrors the machine id and `description` is null.
   * @returns {Promise<Array<{id: string, label: string, description: null}>>}
   */
  async listContentTypes() {
    const map = await this._map();
    return map.nodeBundles().map((bundle) => ({ id: bundle, label: bundle, description: null }));
  }

  /**
   * List the bundles of an entity type (label mirrors id; no description).
   * @param {string} entityType
   * @returns {Promise<Array<{id: string, label: string, description: null}>>}
   */
  async listBundles(entityType) {
    const map = await this._map();
    return map.bundlesOf(entityType).map((bundle) => ({ id: bundle, label: bundle, description: null }));
  }

  /**
   * @returns {Promise<never>}
   * @throws {BackendCapabilityError} Always — roles are not exposed over GraphQL.
   */
  async listRoles() {
    throw new BackendCapabilityError(
      `Listing user roles is not available over the GraphQL backend for site "${this.site._name}". ` +
      "Use a JSON:API site to enumerate roles."
    );
  }

  /**
   * @returns {Promise<never>}
   * @throws {BackendCapabilityError} Always — uploads are not supported over GraphQL.
   */
  async uploadFile() {
    throw new BackendCapabilityError(
      `File upload is not available over the GraphQL backend for site "${this.site._name}". ` +
      "Use a JSON:API site to upload files."
    );
  }

  /**
   * Approximate a count by listing up to the client-record cap.
   * GraphQL has no exact server count, so the bounded result count is always
   * flagged approximate.
   * @param {import("../canonical.js").QueryDescriptor} descriptor
   * @returns {Promise<{count: number, approximate: true}>}
   */
  async countEntities(descriptor) {
    const res = await this.listEntities({ ...descriptor, page: { limit: MAX_CLIENT_RECORDS } });
    return { count: res.entities.length, approximate: true };
  }

  /**
   * List all entity/bundle pairs as resource types.
   * @returns {Promise<Array<{resourceType: string, entityType: string, bundle: string}>>}
   */
  async listResourceTypes() {
    const map = await this._map();
    return map.allEntities().map(({ entityType, bundle }) => ({
      resourceType: `${entityType}--${bundle}`, entityType, bundle,
    }));
  }

  /**
   * Describe a bundle's fields, splitting them into attributes vs.
   * relationships. A field is a relationship when it resolves to another
   * entity — i.e. a union/interface (single or list) or an OBJECT that maps to
   * an entity type (excluding the known scalar-wrapper object types). All other
   * fields are attributes, typed by their named/element type or kind.
   * @param {string} entityType
   * @param {string} bundle
   * @returns {Promise<{entityType: string, bundle: string, resourceType: string, attributes: object, relationships: object}>}
   * @throws {BackendCapabilityError} When the bundle is not queryable.
   */
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

  /**
   * Escape hatch: run a raw GraphQL request and return the raw response.
   * @param {{query: string, variables?: object, operationName?: string}} input
   * @returns {Promise<object>} The raw `{ data, errors? }` response.
   */
  async rawQuery({ query, variables, operationName }) {
    return drupalGraphqlFetch(this.site, { query, variables, operationName });
  }

  /**
   * Resolve the first candidate field name that exists on the bundle.
   * @param {string} entityType
   * @param {string} bundle
   * @param {string[]} candidates Field names in preference order.
   * @returns {Promise<?string>} Matching field name, or null when none match.
   */
  async resolveFieldName(entityType, bundle, candidates) {
    const map = await this._map();
    const entry = map.forEntity(entityType, bundle);
    if (!entry) return null;
    return candidates.find((c) => entry.fields.has(c)) ?? null;
  }
}
