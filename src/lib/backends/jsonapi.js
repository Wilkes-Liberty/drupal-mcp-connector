/**
 * JSON:API backend adapter. Wraps drupalFetch behind the Backend interface,
 * returning canonical entities.
 */

import { drupalFetch, drupalUploadFile } from "../drupal-fetch.js";
import { Backend } from "./backend-interface.js";
import {
  makeCanonicalEntity,
  normalizeRelationship,
  BASE_ATTRIBUTE_FIELDS,
} from "../canonical.js";

const INTERNAL_ATTR_RE = /^drupal_internal__/;

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

function applyFilter(params, { field, op = "eq", value }) {
  if (op === "eq") {
    params.append(`filter[${field}]`, String(value));
    return;
  }
  const key = `c_${field}`;
  params.append(`filter[${key}][condition][path]`, field);
  params.append(`filter[${key}][condition][operator]`, OP_MAP.get(op) || "=");
  if (op === "in" && Array.isArray(value)) {
    value.forEach((v, i) => params.append(`filter[${key}][condition][value][${i}]`, String(v)));
  } else if (op !== "isNull") {
    params.append(`filter[${key}][condition][value]`, String(value));
  }
}

export class JsonApiBackend extends Backend {
  constructor(site) {
    super();
    this.site = site;
  }

  capabilities() {
    return {
      read: true, write: true, delete: true,
      count: true, filter: true, sort: "full", revisions: true,
      fieldAvailability: null,
    };
  }

  resourcePath(entityType, bundle) {
    return `/jsonapi/${entityType}/${bundle}`;
  }

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

  async getEntity({ entityType, bundle, id }) {
    const data = await drupalFetch(this.site, `${this.resourcePath(entityType, bundle)}/${id}`);
    return data?.data ? this.toCanonical(data.data) : null;
  }

  async createEntity({ entityType, bundle, attributes = {}, relationships }) {
    const payload = { data: { type: `${entityType}--${bundle}`, attributes } };
    if (relationships) payload.data.relationships = relationships;
    const data = await drupalFetch(this.site, this.resourcePath(entityType, bundle), {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return this.toCanonical(data.data);
  }

  async updateEntity({ entityType, bundle, id, attributes = {}, relationships }) {
    const payload = { data: { type: `${entityType}--${bundle}`, id, attributes } };
    if (relationships) payload.data.relationships = relationships;
    const data = await drupalFetch(this.site, `${this.resourcePath(entityType, bundle)}/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    return this.toCanonical(data.data);
  }

  async deleteEntity({ entityType, bundle, id }) {
    await drupalFetch(this.site, `${this.resourcePath(entityType, bundle)}/${id}`, { method: "DELETE" });
  }

  async introspect() {
    const data = await drupalFetch(this.site, "/jsonapi");
    const resourceTypes = Object.keys(data.links || {}).filter((k) => k !== "self");
    return { resourceTypes };
  }

  async rawQuery({ path, options }) {
    // Escape hatch for direct JSON:API access (keeps passthrough tools working).
    return drupalFetch(this.site, path, options);
  }

  async listContentTypes() {
    // page[limit]=50 is an intentional cap; matches Drupal JSON:API's default page size.
    const data = await drupalFetch(this.site, "/jsonapi/node_type/node_type?page[limit]=50");
    return (data.data || []).map((ct) => ({
      id: ct.attributes.drupal_internal__type,
      label: ct.attributes.name,
      description: ct.attributes.description ?? null,
    }));
  }

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

  async listRoles() {
    const data = await drupalFetch(this.site, "/jsonapi/user_role/user_role");
    return (data.data || []).map((r) => ({
      id: r.id,
      machineName: r.attributes.drupal_internal__id,
      label: r.attributes.label,
      weight: r.attributes.weight,
    }));
  }

  async countEntities(descriptor) {
    const params = this.compileQuery({ ...descriptor, page: { limit: 1 } });
    const qs = params.toString();
    const base = this.resourcePath(descriptor.entityType, descriptor.bundle);
    const data = await drupalFetch(this.site, qs ? `${base}?${qs}` : base);
    return { count: data.meta?.count ?? (data.data || []).length, approximate: false };
  }

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

  async listResourceTypes() {
    const data = await drupalFetch(this.site, "/jsonapi");
    return Object.keys(data.links || {})
      .filter((k) => k !== "self" && k.includes("--"))
      .map((k) => {
        const [entityType, ...rest] = k.split("--");
        return { resourceType: k, entityType, bundle: rest.join("--") };
      });
  }

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

  resolveFieldName(entityType, bundle, candidates) {
    // JSON:API has no cheap field-availability check; return the first candidate.
    return candidates[0] ?? null;
  }
}
