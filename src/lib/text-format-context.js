/**
 * Text-format restrictions from MCP Sentinel's site schema (#429).
 *
 * A content-tier token cannot read JSON:API `field_config` (that needs
 * "administer node fields") and this connector's production configs often
 * have no Drush bridge. Sentinel's `GET /drupal-mcp/context` is the schema
 * that token can read. When a field entry includes `allowed_formats`, that
 * list is Field API's restriction: one entry is the default, any other
 * format is refused. A missing key means an older Sentinel that does not
 * report the restriction — the caller must not treat that as "all formats".
 * An empty array means the field has no format restriction.
 *
 * Dispatch fills the process cache before a tool that resolves text formats.
 * A failed fetch is remembered only briefly so a Sentinel outage does not
 * add the timeout to every later write, and concurrent writes share one
 * request. Unit tests that call handlers directly can seed a successful
 * document with `rememberTextFormatContext`.
 */

import { authHeadersAsync, clientHeaders } from "./config.js";

/** How long a successful context document is reused. */
const CONTEXT_TTL_MS = 10 * 60 * 1000;

/** How long a miss is remembered. Short, so a recovered Sentinel is retried. */
const FAILURE_TTL_MS = 30 * 1000;

/** Context fetch budget. A miss must not stall the write past this. */
const CONTEXT_TIMEOUT_MS = 8000;

/**
 * Tools whose handlers call the text-format resolver. Other writes must not
 * wait on this document.
 */
const TEXT_FORMAT_TOOLS = new Set([
  "drupal_create_node",
  "drupal_update_node",
  "drupal_entity_create",
  "drupal_entity_update",
  "drupal_create_translation",
  "drupal_bulk_create",
  "drupal_bulk_update",
  "drupal_create_paragraph",
  "drupal_update_paragraph",
  "drupal_create_media",
  "drupal_update_media",
  "drupal_draft_nested_components",
]);

/** @type {Map<string, {at: number, document: ?object, ttl: number}>} */
const cache = new Map();

/** @type {Map<string, Promise<void>>} */
const inflight = new Map();

/** @type {(site: object) => Promise<?object>} */
let fetcher = async () => null;

/**
 * Cache key for one configured site. Name and base URL both matter so two
 * sites that share a name in different processes cannot collide here, and a
 * renamed base URL does not reuse the previous document.
 * @param {object} site Resolved site config.
 * @returns {string}
 */
function cacheKey(site) {
  return `${site?._name ?? ""}\0${site?.baseUrl ?? ""}`;
}

/**
 * Drop cached schema documents. Tests call this between cases.
 * @returns {void}
 */
export function clearTextFormatContextCache() {
  cache.clear();
  inflight.clear();
}

/**
 * Whether this tool resolves text formats and should wait for context.
 * @param {string} toolName
 * @returns {boolean}
 */
export function toolNeedsTextFormatContext(toolName) {
  return TEXT_FORMAT_TOOLS.has(toolName);
}

/**
 * Seed the cache without a network call. A seeded document uses the success TTL.
 * @param {object} site Resolved site config.
 * @param {object} document Sentinel context JSON.
 * @returns {void}
 */
export function rememberTextFormatContext(site, document) {
  cache.set(cacheKey(site), { at: Date.now(), document, ttl: CONTEXT_TTL_MS });
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function fresh(key) {
  const hit = cache.get(key);
  if (!hit) return false;
  return Date.now() - hit.at < hit.ttl;
}

/**
 * Install the process fetcher. The server entry calls this with
 * {@link fetchTextFormatContext}. Tests leave the default, which returns
 * null and does not touch the network.
 * @param {(site: object) => Promise<?object>} next
 * @returns {void}
 */
export function installTextFormatContextFetcher(next) {
  fetcher = next;
}

/**
 * Load `GET /drupal-mcp/context` when the cache is cold. A failure is cached
 * as a miss for 30 seconds: the write keeps the historical path
 * for an unknown format list, and the next write does not wait again.
 * Concurrent callers share one in-flight request.
 * @param {object} site Resolved site config.
 * @returns {Promise<void>}
 */
export async function ensureTextFormatContext(site) {
  if (!site?.baseUrl) return;
  const key = cacheKey(site);
  if (fresh(key)) return;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = loadTextFormatContext(site, key);
  inflight.set(key, job);
  try {
    await job;
  } finally {
    if (inflight.get(key) === job) inflight.delete(key);
  }
}

/**
 * @param {object} site
 * @param {string} key
 * @returns {Promise<void>}
 */
async function loadTextFormatContext(site, key) {
  let document = null;
  try {
    const loaded = await fetcher(site);
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) document = loaded;
  } catch {
    document = null;
  }
  cache.set(key, {
    at: Date.now(),
    document,
    ttl: document ? CONTEXT_TTL_MS : FAILURE_TTL_MS,
  });
}

/**
 * GET /drupal-mcp/context as the site's own principal.
 * @param {object} site Resolved site config.
 * @returns {Promise<?object>} The JSON document, or null on any miss.
 */
export async function fetchTextFormatContext(site) {
  let headers;
  try {
    headers = {
      Accept: "application/json",
      ...clientHeaders(),
      ...(await authHeadersAsync(site)),
    };
  } catch {
    return null;
  }
  let res;
  try {
    res = await fetch(`${site.baseUrl}/drupal-mcp/context`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(CONTEXT_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = await res.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (!Object.prototype.hasOwnProperty.call(body, "content_types")) return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Field definition from a cached context document.
 * Only node bundles are present. A field with no `allowed_formats` key is
 * unknown (older Sentinel), not unrestricted.
 * @param {object} site Resolved site config.
 * @param {string} entityType
 * @param {string} bundle
 * @param {string} fieldName
 * @returns {?{fieldName: string, fieldType: ?string, allowedFormats: string[]}}
 */
export function textFormatDefinitionFromContext(site, entityType, bundle, fieldName) {
  if (entityType !== "node") return null;
  const hit = cache.get(cacheKey(site));
  // A cached miss (document null) is not a schema. Do not invent a list.
  if (!hit?.document || !fresh(cacheKey(site))) return null;
  const types = hit.document?.content_types;
  if (!types || typeof types !== "object" || Array.isArray(types)) return null;
  const schema = new Map(Object.entries(types)).get(bundle);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const fields = new Map(Object.entries(schema)).get("fields");
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const field = new Map(Object.entries(fields)).get(fieldName);
  if (!field || typeof field !== "object" || Array.isArray(field)) return null;
  const attrs = new Map(Object.entries(field));
  if (!attrs.has("allowed_formats")) return null;
  const fieldType = attrs.get("type");
  return {
    fieldName,
    fieldType: typeof fieldType === "string" ? fieldType : null,
    allowedFormats: normalizeContextFormats(attrs.get("allowed_formats")),
  };
}

/**
 * @param {*} raw `allowed_formats` from the context document.
 * @returns {string[]}
 */
function normalizeContextFormats(raw) {
  const values = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === "object" ? [...new Map(Object.entries(raw)).values()] : []);
  return values.filter((value) => typeof value === "string" && value !== "" && value !== "0");
}
