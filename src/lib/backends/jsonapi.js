/**
 * JSON:API backend adapter.
 *
 * Single responsibility: implement the full Backend interface (read + write +
 * delete) against Drupal core JSON:API, translating entity descriptors into
 * JSON:API query strings and JSON:API resources into the shared
 * CanonicalEntity shape. This is the read/write backend; GraphQL is read-only.
 */

import { drupalFetch, drupalUploadFile } from "../drupal-fetch.js";
import { validateUuid, validateMachineName } from "../validate.js";
import { Backend } from "./backend-interface.js";
import {
  makeCanonicalEntity,
  normalizeRelationship,
  BASE_ATTRIBUTE_FIELDS,
} from "../canonical.js";

// Drupal exposes internal numeric ids under drupal_internal__* attributes;
// these are dropped from canonical `fields` (the canonical id is the UUID).
const INTERNAL_ATTR_RE = /^drupal_internal__/;

/**
 * Detect the JSON:API error Drupal returns when a write attempts to set the
 * `status` (published) field on a content_moderation-governed entity. Such
 * entities own their published state via `moderation_state`, so a direct
 * `status` write is refused with a 403 ("Cannot edit the published field of
 * moderated entities" / "not allowed to … field (status)"). Used to decide
 * whether to retry the write without `status`.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isModeratedStatusError(err) {
  const msg = String(err?.message || "");
  return /published field of moderated/i.test(msg) || /field \(status\)/i.test(msg);
}

// Canonical filter op -> JSON:API condition operator.
const OP_MAP = new Map([
  ["neq", "<>"], ["gt", ">"], ["gte", ">="], ["lt", "<"], ["lte", "<="],
  ["contains", "CONTAINS"], ["in", "IN"], ["isNull", "IS NULL"],
]);

// entityType -> JSON:API config-entity resource that enumerates its bundles.
const BUNDLE_ENDPOINTS = new Map([
  ["node", "node_type/node_type"],
  ["taxonomy_term", "taxonomy_vocabulary/taxonomy_vocabulary"],
  ["media", "media_type/media_type"],
]);

// The attribute holding each config entity's machine id, by entity type.
const BUNDLE_ID_ATTR = new Map([
  ["node", "drupal_internal__type"],
  ["taxonomy_term", "drupal_internal__vid"],
  ["media", "drupal_internal__id"],
]);

/**
 * Infer a coarse type label for a sample attribute value, recognizing common
 * Drupal field object shapes (text-with-summary, image, uri, ...) by their key
 * set so schema output is human-meaningful rather than just "object".
 * @param {*} value Sample value.
 * @returns {string} A type label, e.g. "string", "array<number>", "image".
 */
function inferType(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return `array<${inferType(value[0])}>`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort().join(",");
    if (keys === "format,processed,summary,value") return "text_with_summary";
    if (keys === "format,processed,value") return "text_formatted";
    if (keys === "alt,height,target_id,target_type,title,url,width") return "image";
    if (keys === "url,value") return "uri";
    return `object{${keys}}`;
  }
  return typeof value;
}

/**
 * Append one filter condition to a URLSearchParams in JSON:API syntax.
 * Equality uses the shorthand `filter[field]=value`; other operators use the
 * verbose `filter[c_field][condition][...]` form. `in` expands to indexed
 * value params; `isNull` omits the value entirely.
 * @param {URLSearchParams} params Params to mutate.
 * @param {{field: string, op?: string, value: *}} cond Filter condition.
 * @returns {void}
 */
/**
 * Serialize a filter value to a DB-portable string. Booleans become "1"/"0":
 * Drupal stores `status` and other boolean fields in integer/smallint columns,
 * and PostgreSQL rejects the literals "true"/"false" there ("invalid input
 * syntax for type smallint"). MySQL coerces them, which hid this. Everything
 * else is stringified unchanged (the string "true" stays "true").
 * @param {*} value
 * @returns {string}
 */
function filterValue(value) {
  if (value === true) return "1";
  if (value === false) return "0";
  return String(value);
}

function applyFilter(params, { field, op = "eq", value }) {
  if (op === "eq") {
    params.append(`filter[${field}]`, filterValue(value));
    return;
  }
  const key = `c_${field}`;
  params.append(`filter[${key}][condition][path]`, field);
  params.append(`filter[${key}][condition][operator]`, OP_MAP.get(op) || "=");
  if (op === "in" && Array.isArray(value)) {
    value.forEach((v, i) => params.append(`filter[${key}][condition][value][${i}]`, filterValue(v)));
  } else if (op !== "isNull") {
    params.append(`filter[${key}][condition][value]`, filterValue(value));
  }
}

/**
 * Read/write Backend adapter backed by Drupal core JSON:API.
 */
export class JsonApiBackend extends Backend {
  /** @param {object} site Site config (must include `_name`). */
  constructor(site) {
    super();
    this.site = site;
  }

  /**
   * Report capabilities: full read/write/delete, exact count, server-side
   * filter, full sort, revisions.
   * @returns {import("./backend-interface.js").Capabilities}
   */
  capabilities() {
    return {
      read: true, write: true, delete: true,
      count: true, filter: true, sort: "full", revisions: true,
      fieldAvailability: null,
    };
  }

  /**
   * Build the JSON:API collection path for an entity/bundle.
   * @param {string} entityType
   * @param {string} bundle
   * @returns {string} e.g. "/jsonapi/node/article".
   */
  resourcePath(entityType, bundle) {
    // Validate before interpolating into the URL: machine names cannot contain
    // path separators or `..`, so this blocks path-traversal to other resources
    // (e.g. id="../../user/user/…"). Encoding is belt-and-suspenders.
    validateMachineName(entityType, "entityType");
    validateMachineName(bundle, "bundle");
    return `/jsonapi/${encodeURIComponent(entityType)}/${encodeURIComponent(bundle)}`;
  }

  /**
   * Compile an entity descriptor into JSON:API query parameters
   * (filter/sort/sparse-fieldset/include/page).
   * @param {import("../canonical.js").QueryDescriptor} descriptor
   * @returns {URLSearchParams}
   */
  compileQuery(descriptor) {
    const params = new URLSearchParams();
    const { filters = [], sort = [], fields = [], include = [], page = {} } = descriptor;
    for (const f of filters) applyFilter(params, f);
    if (sort.length) {
      params.set("sort", sort.map((s) => (s.dir === "desc" ? "-" : "") + s.field).join(","));
    }
    if (fields.length) {
      params.set(`fields[${descriptor.entityType}--${descriptor.bundle}]`, fields.join(","));
    }
    if (include.length) params.set("include", include.join(","));
    if (page.limit !== undefined && page.limit !== null) params.set("page[limit]", String(page.limit));
    if (page.offset !== undefined && page.offset !== null) params.set("page[offset]", String(page.offset));
    return params;
  }

  /**
   * Convert a JSON:API resource object into a CanonicalEntity. Base attributes
   * (title/status/...) are promoted; drupal_internal__* and base fields are
   * stripped from `fields`; relationships are normalized to canonical refs.
   * @param {object} resource A JSON:API resource object.
   * @returns {import("../canonical.js").CanonicalEntity}
   */
  toCanonical(resource) {
    const [rawType, rawBundle] = (resource.type || "").split("--");
    const entityType = rawType || null;
    const bundle = rawBundle || null;
    const attrs = resource.attributes || {};
    const fields = Object.fromEntries(
      Object.entries(attrs).filter(
        ([k]) => !BASE_ATTRIBUTE_FIELDS.includes(k) && !INTERNAL_ATTR_RE.test(k)
      )
    );
    const relationships = Object.fromEntries(
      Object.entries(resource.relationships || {}).map(([k, rel]) => [k, normalizeRelationship(rel?.data ?? null)])
    );
    return makeCanonicalEntity({
      id: resource.id,
      entityType, bundle,
      title: attrs.title ?? null,
      status: attrs.status ?? null,
      langcode: attrs.langcode ?? null,
      created: attrs.created ?? null,
      changed: attrs.changed ?? null,
      url: attrs.path?.alias ?? null,
      fields, relationships,
      backend: "jsonapi",
    });
  }

  /**
   * List entities for a descriptor. Server-side filter/sort/paging means the
   * result is always exact (`approximate`/`truncated` are false).
   * @param {import("../canonical.js").QueryDescriptor} descriptor
   * @returns {Promise<import("./backend-interface.js").ListResult>}
   */
  async listEntities(descriptor) {
    const params = this.compileQuery(descriptor);
    const qs = params.toString();
    const base = this.resourcePath(descriptor.entityType, descriptor.bundle);
    const path = qs ? `${base}?${qs}` : base;
    const data = await drupalFetch(this.site, path);
    const entities = (data.data || []).map((r) => this.toCanonical(r));
    const total = data.meta?.count ?? entities.length;
    return {
      entities,
      page: { total, hasNext: Boolean(data.links?.next), cursor: null },
      approximate: false,
      truncated: false,
    };
  }

  /**
   * Fetch a single entity by id.
   * @param {{entityType: string, bundle: string, id: string}} ref
   * @returns {Promise<?import("../canonical.js").CanonicalEntity>} Entity, or null.
   */
  async getEntity({ entityType, bundle, id }) {
    validateUuid(id);
    const data = await drupalFetch(this.site, `${this.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}`);
    return data?.data ? this.toCanonical(data.data) : null;
  }

  /**
   * Issue a JSON:API write, transparently retrying once without the `status`
   * attribute if the target bundle is under a content_moderation workflow.
   *
   * Moderated entities derive their published state from `moderation_state` and
   * reject a direct `status` write with a 403. This lets create/update "just
   * work" on moderated bundles using the connector's safe default `status:false`:
   * the retry drops `status` and Drupal applies the workflow's default state
   * (typically draft — i.e. still unpublished, preserving the no-auto-publish
   * guarantee). Callers that need a specific state pass `moderation_state`
   * explicitly, in which case `status` is absent and no retry occurs.
   *
   * @param {string} path JSON:API resource path.
   * @param {"POST"|"PATCH"} method HTTP method.
   * @param {(attrs: object) => object} buildPayload Builds the request body from an attribute map.
   * @param {object} attributes Entity attributes (may include `status`).
   * @returns {Promise<object>} The JSON:API response body.
   */
  async writeWithModerationFallback(path, method, buildPayload, attributes) {
    try {
      return await drupalFetch(this.site, path, { method, body: JSON.stringify(buildPayload(attributes)) });
    } catch (err) {
      if (!isModeratedStatusError(err) || !("status" in attributes)) throw err;
      const withoutStatus = { ...attributes };
      delete withoutStatus.status;
      return drupalFetch(this.site, path, { method, body: JSON.stringify(buildPayload(withoutStatus)) });
    }
  }

  /**
   * Create an entity via JSON:API POST. Retries without `status` on moderated
   * bundles — see writeWithModerationFallback.
   * @param {{entityType: string, bundle: string, attributes?: object, relationships?: object}} input
   * @returns {Promise<import("../canonical.js").CanonicalEntity>} The created entity.
   */
  async createEntity({ entityType, bundle, attributes = {}, relationships }) {
    const buildPayload = (attrs) => {
      const payload = { data: { type: `${entityType}--${bundle}`, attributes: attrs } };
      if (relationships) payload.data.relationships = relationships;
      return payload;
    };
    const data = await this.writeWithModerationFallback(this.resourcePath(entityType, bundle), "POST", buildPayload, attributes);
    return this.toCanonical(data.data);
  }

  /**
   * Update an entity via JSON:API PATCH. Retries without `status` on moderated
   * bundles — see writeWithModerationFallback.
   * @param {{entityType: string, bundle: string, id: string, attributes?: object, relationships?: object}} input
   * @returns {Promise<import("../canonical.js").CanonicalEntity>} The updated entity.
   */
  async updateEntity({ entityType, bundle, id, attributes = {}, relationships }) {
    validateUuid(id);
    const buildPayload = (attrs) => {
      const payload = { data: { type: `${entityType}--${bundle}`, id, attributes: attrs } };
      if (relationships) payload.data.relationships = relationships;
      return payload;
    };
    const data = await this.writeWithModerationFallback(`${this.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}`, "PATCH", buildPayload, attributes);
    return this.toCanonical(data.data);
  }

  /**
   * Delete an entity via JSON:API DELETE.
   * @param {{entityType: string, bundle: string, id: string}} ref
   * @returns {Promise<void>}
   */
  async deleteEntity({ entityType, bundle, id }) {
    validateUuid(id);
    await drupalFetch(this.site, `${this.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /**
   * Discover resource types from the JSON:API entry-point links.
   * @returns {Promise<{resourceTypes: string[]}>}
   */
  async introspect() {
    const data = await drupalFetch(this.site, "/jsonapi");
    const resourceTypes = Object.keys(data.links || {}).filter((k) => k !== "self");
    return { resourceTypes };
  }

  /**
   * Escape hatch for direct JSON:API access (keeps passthrough tools working).
   * @param {{path: string, options?: object}} input Request path and fetch options.
   * @returns {Promise<*>} The raw JSON:API response.
   */
  async rawQuery({ path, options }) {
    return drupalFetch(this.site, path, options);
  }

  /**
   * List node content types with labels and descriptions.
   * @returns {Promise<Array<{id: string, label: string, description: ?string}>>}
   */
  async listContentTypes() {
    // page[limit]=50 is an intentional cap; matches Drupal JSON:API's default page size.
    const data = await drupalFetch(this.site, "/jsonapi/node_type/node_type?page[limit]=50");
    return (data.data || []).map((ct) => ({
      id: ct.attributes.drupal_internal__type,
      label: ct.attributes.name,
      description: ct.attributes.description ?? null,
    }));
  }

  /**
   * List the bundles of an entity type via its config-entity resource.
   * Attribute reads use Map(Object.entries()) to stay object-injection-safe.
   * @param {string} entityType One of the keys in BUNDLE_ENDPOINTS.
   * @returns {Promise<Array<{id: string, label: ?string, description: ?string}>>}
   * @throws {Error} When no bundle endpoint is known for the entity type.
   */
  async listBundles(entityType) {
    const endpoint = BUNDLE_ENDPOINTS.get(entityType);
    if (!endpoint) {
      throw new Error(`No bundle endpoint known for entity type "${entityType}".`);
    }
    const idAttr = BUNDLE_ID_ATTR.get(entityType) ?? "drupal_internal__id";
    const data = await drupalFetch(this.site, `/jsonapi/${endpoint}?page[limit]=100`);
    return (data.data || []).map((b) => {
      const a = new Map(Object.entries(b.attributes));
      return {
        id: a.get(idAttr) ?? a.get("drupal_internal__id"),
        label: a.get("name") ?? a.get("label") ?? null,
        description: a.get("description") ?? null,
      };
    });
  }

  /**
   * List user roles.
   * @returns {Promise<Array<{id: string, machineName: string, label: string, weight: number}>>}
   */
  async listRoles() {
    const data = await drupalFetch(this.site, "/jsonapi/user_role/user_role");
    return (data.data || []).map((r) => ({
      id: r.id,
      machineName: r.attributes.drupal_internal__id,
      label: r.attributes.label,
      weight: r.attributes.weight,
    }));
  }

  /**
   * Return an exact entity count. Requests page[limit]=1 and reads the
   * server-provided meta.count, so no full result set is transferred.
   * @param {import("../canonical.js").QueryDescriptor} descriptor
   * @returns {Promise<{count: number, approximate: false}>}
   */
  async countEntities(descriptor) {
    const params = this.compileQuery({ ...descriptor, page: { limit: 1 } });
    const qs = params.toString();
    const base = this.resourcePath(descriptor.entityType, descriptor.bundle);
    const data = await drupalFetch(this.site, qs ? `${base}?${qs}` : base);
    return { count: data.meta?.count ?? (data.data || []).length, approximate: false };
  }

  /**
   * Upload a file and return its descriptor.
   * @param {{entityType?: string, bundle: string, fieldName: string, filePath: string}} opts
   * @returns {Promise<{id: string, drupalId: number, filename: string, uri: ?string, url: ?string, size: number, mimeType: string}>}
   */
  async uploadFile({ entityType = "media", bundle, fieldName, filePath }) {
    const data = await drupalUploadFile(this.site, entityType, bundle, fieldName, filePath);
    const f = data.data;
    return {
      id: f.id,
      drupalId: f.attributes.drupal_internal__fid,
      filename: f.attributes.filename,
      uri: f.attributes.uri?.value ?? null,
      url: f.attributes.uri?.url ?? null,
      size: f.attributes.filesize,
      mimeType: f.attributes.filemime,
    };
  }

  /**
   * List resource types as entity/bundle pairs from the entry-point links.
   * Only `entityType--bundle` link keys are included.
   * @returns {Promise<Array<{resourceType: string, entityType: string, bundle: string}>>}
   */
  async listResourceTypes() {
    const data = await drupalFetch(this.site, "/jsonapi");
    return Object.keys(data.links || {})
      .filter((k) => k !== "self" && k.includes("--"))
      .map((k) => {
        const [entityType, ...rest] = k.split("--");
        return { resourceType: k, entityType, bundle: rest.join("--") };
      });
  }

  /**
   * Describe a bundle's fields by sampling one entity and inferring attribute
   * types from its values. JSON:API has no schema endpoint, so an empty bundle
   * yields a `note` and empty maps.
   * @param {string} entityType
   * @param {string} bundle
   * @returns {Promise<{entityType: string, bundle: string, resourceType?: string, note?: string, attributes: object, relationships: object}>}
   */
  async getEntitySchema(entityType, bundle) {
    const data = await drupalFetch(this.site, `${this.resourcePath(entityType, bundle)}?page[limit]=1`);
    if (!data.data?.length) {
      return { entityType, bundle, note: "No entities exist yet — schema unavailable.", attributes: {}, relationships: {} };
    }
    const sample = data.data[0];
    const attributes = Object.fromEntries(
      Object.entries(sample.attributes ?? {}).map(([k, v]) => [k, inferType(v)])
    );
    const relationships = Object.fromEntries(
      Object.keys(sample.relationships ?? {}).map((k) => [k, "relationship"])
    );
    return { entityType, bundle, resourceType: sample.type, attributes, relationships };
  }

  /**
   * Resolve a field name from candidates. JSON:API has no cheap
   * field-availability check, so the first candidate is returned optimistically.
   * @param {string} entityType
   * @param {string} bundle
   * @param {string[]} candidates Field names in preference order.
   * @returns {?string} The first candidate, or null when the list is empty.
   */
  resolveFieldName(entityType, bundle, candidates) {
    return candidates[0] ?? null;
  }
}
