/**
 * JSON:API backend adapter.
 *
 * Single responsibility: implement the full Backend interface (read + write +
 * delete) against Drupal core JSON:API, translating entity descriptors into
 * JSON:API query strings and JSON:API resources into the shared
 * CanonicalEntity shape. This is the read/write backend; GraphQL is read-only.
 */

import { drupalFetch, drupalUploadFile } from "../drupal-fetch.js";
import { getRequestIdentity } from "../principal.js";
import { validateUuid, validateMachineName } from "../validate.js";
import { parseFieldConfigObject } from "../field-definition.js";
import { Backend } from "./backend-interface.js";
import {
  makeCanonicalEntity,
  normalizeRelationship,
  BASE_ATTRIBUTE_FIELDS,
} from "../canonical.js";
import { isPositiveNid, normalizeAlias, PATH_ALIAS_ENTITY_TYPE } from "../path-alias.js";

// Drupal exposes internal identifiers under drupal_internal__* attributes.
// They are dropped from canonical `fields` except for the identifiers that
// governed read/write workflows explicitly need.
const INTERNAL_ATTR_RE = /^drupal_internal__/;

// countEntities() / listEntities() pagination. Drupal core JSON:API returns no
// total in `meta` and silently caps `page[limit]` at OffsetPage::SIZE_MAX
// (50 by default). COUNT_PAGE_SIZE matches that default; COUNT_MAX_RECORDS
// bounds a walk so a huge collection can't issue unbounded requests (mirrors
// the GraphQL backend's MAX_CLIENT_RECORDS) — past it the count is approximate.
const COUNT_PAGE_SIZE = 50;
const COUNT_MAX_RECORDS = 1000;

/**
 * Whether a JSON:API collection document advertises another page.
 * `links.next` may be a string href or a `{ href }` link object.
 * @param {?object} data JSON:API document.
 * @returns {boolean}
 */
function jsonApiHasNext(data) {
  const next = data?.links?.next;
  if (next === undefined || next === null || next === false) return false;
  if (typeof next === "string") return next.length > 0;
  if (typeof next === "object" && next.href !== undefined && next.href !== null) {
    return String(next.href).length > 0;
  }
  return Boolean(next);
}

/**
 * Detect the JSON:API error Drupal returns when a write attempts to set the
 * `status` (published) field on a content_moderation-governed entity. Such
 * entities own their published state via `moderation_state`, so a direct
 * `status` write is refused with "Cannot edit the published field of moderated
 * entities." Used to decide whether to retry the write without `status`.
 *
 * Matched narrowly, on that moderation-specific phrase only. A generic
 * field-access denial ("The current user is not allowed to … the field
 * (status)") is a *permission* refusal, not a moderation quirk — matching it
 * here would silently drop a caller's status change and return success (#111).
 * That case must surface, so it is deliberately excluded.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isModeratedStatusError(err) {
  const msg = String(err?.message || "");
  return /published field of moderated/i.test(msg);
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
 * Bind JSON:API `uid` from the grant-stamped identity. Caller uid is overwritten.
 * User entities are left unchanged. No actor claim (auth.actors not in effect
 * for this principal) leaves relationships as-is — the path before actor mapping (#247).
 * A *present* actor claim that fails UUID validation fails closed (throws)
 * rather than silently keeping a caller-supplied uid: resolveActor()/
 * normalizeActors() already validate the shape before stamping identity.actor,
 * so this should be unreachable in the normal path — it exists so a future
 * bug upstream of this call can never downgrade into "trust the caller".
 *
 * @param {string} entityType
 * @param {object|undefined} relationships
 * @returns {object|undefined}
 */
export function grantActorUid(entityType, relationships) {
  if (entityType === "user") return relationships;
  const uuid = getRequestIdentity()?.actor;
  if (typeof uuid !== "string") return relationships;
  validateUuid(uuid, "actor");
  const base = relationships && typeof relationships === "object" && !Array.isArray(relationships)
    ? relationships
    : {};
  return {
    ...base,
    uid: { data: { type: "user--user", id: uuid } },
  };
}

/** Read/write Backend adapter backed by Drupal core JSON:API. */
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
   * (title/status/...) are promoted; base fields and unneeded
   * drupal_internal__* attributes are stripped from `fields`; relationships
   * are normalized to canonical refs.
   * @param {object} resource A JSON:API resource object.
   * @returns {import("../canonical.js").CanonicalEntity}
   */
  toCanonical(resource) {
    const [rawType, rawBundle] = (resource.type || "").split("--");
    const entityType = rawType || null;
    const bundle = rawBundle || null;
    const attrs = resource.attributes || {};
    const fields = Object.fromEntries(
      Object.entries(attrs).filter(([k]) => {
        if (BASE_ATTRIBUTE_FIELDS.includes(k)) return false;
        if (INTERNAL_ATTR_RE.test(k)) {
          // Node reads expose the numeric nid advertised by schema discovery
          // while the UUID remains the canonical top-level id (#237).
          // Paragraph ERR attach needs the current revision id (#192).
          // Node / revisionable writes need the working vs live vid (#166).
          // Other drupal_internal__* attributes stay stripped.
          return (entityType === "node" && k === "drupal_internal__nid")
            || k === "drupal_internal__vid"
            || (entityType === "paragraph" && k === "drupal_internal__revision_id");
        }
        return true;
      })
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
   * List entities for a descriptor.
   *
   * Drupal core JSON:API has no `meta.count` (jsonapi_extras can add it) and
   * silently caps `page[limit]` at OffsetPage::SIZE_MAX (50 by default). When
   * the caller asks for more rows than one Drupal page returns and
   * `links.next` is present, this method follows that link until the requested
   * window is filled, the collection ends, or COUNT_MAX_RECORDS is hit.
   * `page.total` is exact when `meta.count` is present or this window reached
   * the end; otherwise it is the number of rows seen so far and `approximate`
   * is true. Never report a single page's length as an exact collection total.
   *
   * @param {import("../canonical.js").QueryDescriptor} descriptor
   * @returns {Promise<import("./backend-interface.js").ListResult>}
   */
  async listEntities(descriptor) {
    const requestedLimit = descriptor.page?.limit;
    const startOffset = descriptor.page?.offset ?? 0;
    const fillTo = typeof requestedLimit === "number"
      ? Math.min(Math.max(0, requestedLimit), COUNT_MAX_RECORDS)
      : null;

    const entities = [];
    let offset = startOffset;
    let hasNext = false;
    let metaCount = null;

    for (;;) {
      const remaining = fillTo === null ? requestedLimit : fillTo - entities.length;
      const page = {
        ...descriptor.page,
        offset,
        ...(typeof remaining === "number" ? { limit: remaining } : {}),
      };
      const params = this.compileQuery({ ...descriptor, page });
      const qs = params.toString();
      const base = this.resourcePath(descriptor.entityType, descriptor.bundle);
      const path = qs ? `${base}?${qs}` : base;
      const data = await drupalFetch(this.site, path);
      if (metaCount === null && typeof data?.meta?.count === "number") {
        metaCount = data.meta.count;
      }
      const pageEntities = (data.data || []).map((r) => this.toCanonical(r));
      entities.push(...pageEntities);
      hasNext = jsonApiHasNext(data);

      if (fillTo === null) break;
      if (!hasNext || pageEntities.length === 0) break;
      if (entities.length >= fillTo) break;
      offset += pageEntities.length;
    }

    const truncated = fillTo !== null
      && typeof requestedLimit === "number"
      && entities.length < requestedLimit
      && hasNext;
    const seen = startOffset + entities.length;
    const exact = typeof metaCount === "number" || !hasNext;
    return {
      entities,
      page: {
        total: typeof metaCount === "number" ? metaCount : seen,
        hasNext,
        cursor: null,
      },
      approximate: !exact,
      truncated,
    };
  }

  /**
   * Fetch a single entity by id.
   * @param {{entityType: string, bundle: string, id: string, resourceVersion?: string}} ref
   * @returns {Promise<?import("../canonical.js").CanonicalEntity>} Entity, or null.
   */
  async getEntity({ entityType, bundle, id, resourceVersion }) {
    validateUuid(id);
    let path = `${this.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}`;
    if (resourceVersion) {
      path += `?resourceVersion=${encodeURIComponent(resourceVersion)}`;
    }
    const data = await drupalFetch(this.site, path);
    return data?.data ? this.toCanonical(data.data) : null;
  }

  /**
   * Read the raw `path` field (alias + pid + langcode) and internal id of an
   * entity. The canonical entity only surfaces `path.alias` as `url`, but a
   * correct in-place alias *update* must round-trip the existing alias's `pid`
   * (Drupal `PathItem::postSave` creates a duplicate alias when `pid` is absent)
   * — so this method exposes it. Returns nulls for entities/backends without a
   * path field. See the 1.5.1 alias fix.
   *
   * Unpublished default / forward revisions often omit `pid` on the computed
   * `path` field even when a `path_alias` row exists. When the node numeric id
   * is known, this method also looks up that row (aliases are not revisioned)
   * so title-only edits can pin the live alias (#274).
   * @param {{entityType: string, bundle: string, id: string, resourceVersion?: string}} ref
   * @returns {Promise<{alias: ?string, pid: ?(number|string), langcode: ?string, drupalId: ?(number|string), aliasId: ?string}>}
   */
  async getPathInfo({ entityType, bundle, id, resourceVersion }) {
    validateUuid(id);
    let path = `${this.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}`;
    if (resourceVersion) {
      path += `?resourceVersion=${encodeURIComponent(resourceVersion)}`;
    }
    const data = await drupalFetch(this.site, path);
    const attrs = data?.data?.attributes ?? {};
    const nodePath = attrs.path ?? null;
    const drupalId = attrs.drupal_internal__nid ?? attrs.drupal_internal__id ?? null;
    const langcode = nodePath?.langcode ?? attrs.langcode ?? null;
    let alias = nodePath?.alias ?? null;
    let pid = nodePath?.pid ?? null;
    let aliasId = null;

    if (entityType === "node" && isPositiveNid(drupalId)) {
      const row = await this.lookupPathAliasRow(`/node/${Number(drupalId)}`, {
        langcode,
        preferredAlias: alias,
      });
      if (row) {
        aliasId = row.id;
        if (pid === undefined || pid === null) pid = row.pid;
        // Pathauto / unpublished computed fields can omit alias; the row is
        // the router-visible value.
        if (!alias) alias = row.alias;
      }
    }

    return { alias, pid, langcode, drupalId, aliasId };
  }

  /**
   * Load the path_alias row for a node source path. Best-effort: missing
   * JSON:API exposure or an empty collection returns null.
   * @param {string} sourcePath Drupal system path, e.g. `/node/44`.
   * @param {{langcode?: ?string, preferredAlias?: ?string}} [opts]
   * @returns {Promise<?{id: string, alias: ?string, pid: ?(number|string), langcode: ?string}>}
   */
  async lookupPathAliasRow(sourcePath, opts = {}) {
    if (!/^\/node\/[1-9]\d*$/.test(sourcePath)) return null;
    const params = new URLSearchParams();
    params.set("filter[path]", sourcePath);
    if (opts.langcode) params.set("filter[langcode]", String(opts.langcode));
    let data;
    try {
      data = await drupalFetch(
        this.site,
        `${this.resourcePath(PATH_ALIAS_ENTITY_TYPE, PATH_ALIAS_ENTITY_TYPE)}?${params}`,
      );
    } catch {
      return null;
    }
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (!rows.length) return null;
    const preferred = normalizeAlias(opts.preferredAlias);
    let picked = rows[0];
    if (preferred) {
      for (const row of rows) {
        const attrs = row && typeof row === "object" ? row.attributes : null;
        const rowAlias = attrs && typeof attrs === "object" ? attrs.alias : null;
        if (normalizeAlias(rowAlias) === preferred) {
          picked = row;
          break;
        }
      }
    }
    if (!picked?.id) return null;
    const a = picked.attributes && typeof picked.attributes === "object" ? picked.attributes : {};
    return {
      id: picked.id,
      alias: a.alias ?? null,
      pid: a.drupal_internal__id ?? a.pid ?? null,
      langcode: a.langcode ?? null,
    };
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
      const rels = grantActorUid(entityType, relationships);
      if (rels) payload.data.relationships = rels;
      return payload;
    };
    const data = await this.writeWithModerationFallback(this.resourcePath(entityType, bundle), "POST", buildPayload, attributes);
    return this.toCanonical(data.data);
  }

  /**
   * Update an entity via JSON:API PATCH. Retries without `status` on moderated
   * bundles — see writeWithModerationFallback.
   * @param {{entityType: string, bundle: string, id: string, attributes?: object, relationships?: object, resourceVersion?: string}} input
   *   `resourceVersion` is a JSON:API revision selector (e.g. `rel:working-copy`).
   *   When set, it is appended so a forward revision is PATCHed instead of the
   *   canonical default (#166 / Drupal #2795279).
   * @returns {Promise<import("../canonical.js").CanonicalEntity>} The updated entity.
   */
  async updateEntity({ entityType, bundle, id, attributes = {}, relationships, resourceVersion }) {
    validateUuid(id);
    const buildPayload = (attrs) => {
      const payload = { data: { type: `${entityType}--${bundle}`, id, attributes: attrs } };
      const rels = grantActorUid(entityType, relationships);
      if (rels) payload.data.relationships = rels;
      return payload;
    };
    let path = `${this.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}`;
    if (resourceVersion) {
      path += `?resourceVersion=${encodeURIComponent(resourceVersion)}`;
    }
    const data = await this.writeWithModerationFallback(path, "PATCH", buildPayload, attributes);
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
   * Count entities matching the descriptor. Drupal core JSON:API exposes no
   * total in `meta`, so unless the site provides `meta.count` (jsonapi_extras /
   * a custom normalizer), the count is obtained by walking pages via
   * `links.next`. The total is exact when the walk reaches the end; if it hits
   * the COUNT_MAX_RECORDS safety ceiling first, the partial total is returned
   * with `approximate: true` (i.e. the true count is at least that value).
   * @param {import("../canonical.js").QueryDescriptor} descriptor
   * @returns {Promise<{count: number, approximate: boolean}>}
   */
  async countEntities(descriptor) {
    const base = this.resourcePath(descriptor.entityType, descriptor.bundle);
    let total = 0;
    let offset = 0;
    for (;;) {
      const params = this.compileQuery({ ...descriptor, page: { limit: COUNT_PAGE_SIZE, offset } });
      const qs = params.toString();
      const data = await drupalFetch(this.site, qs ? `${base}?${qs}` : base);

      // Prefer an exact server-supplied total when the site exposes one
      // (jsonapi_extras / a custom normalizer). Only the first page can carry it.
      if (offset === 0 && typeof data?.meta?.count === "number") {
        return { count: data.meta.count, approximate: false };
      }

      const got = (data?.data || []).length;
      total += got;

      // No further page advertised → the whole set has been walked: exact.
      if (!data?.links?.next?.href || got === 0) {
        return { count: total, approximate: false };
      }

      // Advance by the rows actually returned (robust to server-side page-size
      // caps that may return fewer than COUNT_PAGE_SIZE per page).
      offset += got;

      // Bounded walk: stop and flag the partial total as approximate.
      if (total >= COUNT_MAX_RECORDS) {
        return { count: total, approximate: true };
      }
    }
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
   * Read Field API metadata from JSON:API `field_config` (chain step 1).
   *
   * This is an internal introspection call, not an agent entity-tool read:
   * `field_config` is on the connector deny list. Do not invent
   * `allowed_formats` from `this.site.defaultTextFormat` or `full_html`.
   * Empty / unreadable `field_config` returns null so the caller can try
   * Drush `config:get field.field.{entityType}.{bundle}.{field}` and, if
   * that also fails, keep the historical default chain only while the list
   * is unknown.
   *
   * @param {{entityType: string, bundle: string, fieldName: string}} ref
   * @returns {Promise<?{fieldName: string, fieldType: ?string, allowedFormats: string[]}>}
   */
  async getFieldDefinition({ entityType, bundle, fieldName }) {
    validateMachineName(entityType, "entityType");
    validateMachineName(bundle, "bundle");
    validateMachineName(fieldName, "fieldName");
    const params = new URLSearchParams();
    params.set("filter[entity_type]", entityType);
    params.set("filter[bundle]", bundle);
    params.set("filter[field_name]", fieldName);
    params.set("page[limit]", "1");
    let data;
    try {
      data = await drupalFetch(this.site, `/jsonapi/field_config/field_config?${params}`);
    } catch {
      return null;
    }
    const row = Array.isArray(data?.data) ? data.data[0] : data?.data;
    return parseFieldConfigObject(row?.attributes, fieldName);
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
