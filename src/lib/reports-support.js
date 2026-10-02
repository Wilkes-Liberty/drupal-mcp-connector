/**
 * Shared helpers for the reporting tools — backend-neutral.
 */

import { assertReadAllowed } from "./security.js";

/** Canonical base property names (read directly off the entity, not from `fields`). */
const BASE_KEYS = new Set(["id", "title", "status", "langcode", "created", "changed", "url"]);

/** Whole-day length in milliseconds, used by daysSince(). */
const MS_PER_DAY = 86400000;

/**
 * Collect up to maxItems canonical entities by paging listEntities via offset.
 * Stops early once a short page or a falsy hasNext signals the end of results.
 * @param {{listEntities: Function}} backend Resolved backend with listEntities().
 * @param {object} descriptor Query descriptor passed through to listEntities.
 * @param {number} [maxItems] Hard cap on total entities returned.
 * @param {number} [chunk] Per-request page size (default 50, matching JSON:API's cap).
 * @returns {Promise<object[]>} Up to maxItems canonical entities.
 */
export async function collectEntities(backend, descriptor, maxItems = 100, chunk = 50) {
  const out = [];
  let offset = 0;
  for (;;) {
    const limit = Math.min(chunk, maxItems - out.length);
    if (limit <= 0) break;
    const res = await backend.listEntities({ ...descriptor, page: { limit, offset } });
    const batch = res.entities ?? [];
    out.push(...batch);
    if (batch.length < limit || !res.page?.hasNext) break;
    offset += batch.length;
  }
  return out.slice(0, maxItems);
}

/**
 * Build a structured "report unavailable" result (returned, not thrown, so a
 * caller can report a gated feature without aborting a batch of reports).
 * @param {string} report Report identifier.
 * @param {string} backend Backend the report was attempted against.
 * @param {string} reason Why the report cannot run here.
 * @returns {{unavailable: true, report: string, backend: string, reason: string}}
 */
export function gatedReport(report, backend, reason) {
  return { unavailable: true, report, backend, reason };
}

/**
 * Read a value from a canonical entity by trying base props then `fields`,
 * returning the first candidate name that resolves to a defined value.
 * @param {object} entity Canonical entity.
 * @param {string[]} candidates Field/prop names to try, in priority order.
 * @returns {*} The first matching value, or undefined if none match.
 */
export function fieldValue(entity, candidates) {
  const base = new Map(Object.entries(entity));
  const fields = entity.fields ? new Map(Object.entries(entity.fields)) : new Map();
  for (const name of candidates) {
    if (BASE_KEYS.has(name)) {
      if (base.has(name) && base.get(name) !== undefined) return base.get(name);
      continue;
    }
    if (fields.has(name)) return fields.get(name);
  }
  return undefined;
}

/**
 * Read a field off a canonical entity and say whether its KEY was there.
 *
 * JSON:API keeps the key of an empty field (value `null`, `[]`, or
 * `data: null`) and leaves out the key of a field the account may not view.
 * So an absent key and an empty value are different facts, and callers that
 * count "missing" values must keep them apart (#337).
 *
 * Looks in `fields`, then `relationships`. Promoted base attributes (`title`,
 * `status`, `langcode`, `created`, `changed`, and `path` as `url`) are always
 * carried by the canonical shape, so they always read as present: a denied
 * base attribute cannot be told from an empty one after promotion.
 *
 * @param {object} entity Canonical entity.
 * @param {string} field Field machine name.
 * @returns {{present: boolean, value: *}} `present` is about the key, not the value.
 */
export function fieldPresence(entity, field) {
  const name = field === "path" ? "url" : field;
  if (BASE_KEYS.has(name)) {
    return { present: true, value: new Map(Object.entries(entity ?? {})).get(name) };
  }
  const fields = new Map(Object.entries(entity?.fields ?? {}));
  if (fields.has(name)) return { present: true, value: fields.get(name) };
  const relationships = new Map(Object.entries(entity?.relationships ?? {}));
  if (relationships.has(name)) return { present: true, value: relationships.get(name) };
  return { present: false, value: undefined };
}

/**
 * Whole days elapsed between a date and now.
 * @param {?(string|number|Date)} dateValue A date parseable by `new Date()`.
 * @returns {?number} Whole days since the date, or null when no date is given.
 */
export function daysSince(dateValue) {
  if (!dateValue) return null;
  return Math.floor((Date.now() - new Date(dateValue).getTime()) / MS_PER_DAY);
}

/**
 * Whether a canonical field or relationship value carries no content.
 *
 * Handles scalars, `{value}` text objects, arrays, relationship refs
 * (`{id}` / `[{id}, …]` / `null`), and keyed objects such as a link
 * (`{uri, title}`). A keyed object with at least one key and none of the
 * known value keys counts as populated.
 *
 * @param {*} value A value read off an entity's base props, `fields`, or `relationships`.
 * @returns {boolean} True when the value is absent or carries no content.
 */
export function isEmptyFieldValue(value) {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.every((item) => isEmptyFieldValue(item));
  if (typeof value === "object") {
    if ("id" in value) return !value.id;
    if ("value" in value) return value.value === undefined || value.value === null || value.value === "";
    if ("target_id" in value) return value.target_id === undefined || value.target_id === null;
    if ("uri" in value) return !value.uri;
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * Note attached to a report's `notVisible` list: requested fields whose key is
 * absent from every sampled entity, so the report could not score them (#341).
 */
export const FIELDS_NOT_VISIBLE_NOTE =
  "These fields are absent from every sampled entity (the key is missing, not empty). " +
  "Each may be denied to this account or not exist on this bundle, or the name may be wrong. " +
  "Drupal leaves a field the account may not view out of the response with no marker, so this report cannot tell whether any value is missing. " +
  "They were not scored.";

/**
 * Normalize a caller's `fields` argument to distinct, non-empty field names.
 * Arguments are not schema-validated before they reach a handler, so a single
 * string is read as one name and non-string entries are dropped.
 * @param {*} fields The raw `fields` argument.
 * @returns {string[]} Field names, or [] when the caller named none.
 */
export function requestedFieldNames(fields) {
  const list = typeof fields === "string" ? [fields] : (Array.isArray(fields) ? fields : []);
  return [...new Set(list.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim()))];
}

/**
 * Return the content type a bundle-scoped tool reads, or fail clearly.
 * Node tools used to default to `article`, which 404s on a site without that
 * bundle (#403). There is no bundle every site has, so the caller names one.
 * @param {?string} type Content type machine name from the caller.
 * @param {string} tool Tool name, for the message.
 * @param {string} [argName] Argument name, for the message.
 * @returns {string} The content type.
 * @throws {Error} When no type was given.
 */
export function requireContentType(type, tool, argName = "type") {
  if (typeof type === "string" && type.trim()) return type;
  throw new Error(
    `${tool} reads one content type: pass ${argName} (a node bundle machine name). ` +
    "Call drupal_list_content_types to see the bundles on this site.",
  );
}

/**
 * Node bundles a tool may read when the caller named none. Bundles that
 * connector policy denies are left out; they are not the caller's to see.
 * @param {{listContentTypes: Function}} backend Resolved backend.
 * @param {object} sec Resolved security config.
 * @returns {Promise<string[]>} Bundle machine names.
 */
export async function readableNodeBundles(backend, sec) {
  const types = await backend.listContentTypes();
  return types.map((ct) => ct?.id).filter((id) => {
    if (!id) return false;
    try {
      assertReadAllowed(sec, "node", id);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * List nodes from several bundles with one descriptor, merged newest first by
 * `sortField`. A bundle that fails to load fails the whole call with the
 * bundle named, so a partial list is never returned as complete (#403).
 * @param {{listEntities: Function}} backend Resolved backend.
 * @param {string[]} bundles Node bundles to read.
 * @param {object} descriptor listEntities descriptor without `bundle`.
 * @param {number} limit Max nodes returned.
 * @param {string} [sortField] Canonical date property to merge by.
 * @returns {Promise<object[]>} Canonical entities.
 * @throws {Error} When any bundle fails to load.
 */
export async function listNodesAcrossBundles(backend, bundles, descriptor, limit, sortField = "changed") {
  const found = [];
  for (const bundle of bundles) {
    let res;
    try {
      res = await backend.listEntities({ ...descriptor, entityType: "node", bundle, page: { limit } });
    } catch (err) {
      throw new Error(`Could not read content type '${bundle}': ${err?.message || err}. Pass type to read one content type.`, { cause: err });
    }
    found.push(...(res.entities ?? []));
  }
  const key = (e) => String(new Map(Object.entries(e ?? {})).get(sortField) ?? "");
  found.sort((x, y) => key(y).localeCompare(key(x)));
  return found.slice(0, limit);
}
