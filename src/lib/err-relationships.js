/**
 * Resolve Entity Reference Revisions identifiers before a host write (#192).
 *
 * Drupal's ERR item is empty unless both `target_id` and `target_revision_id`
 * are set. JSON:API only receives the revision id when the resource identifier
 * carries `meta.target_revision_id`. Sending `{ type, id }` persists an empty
 * field — not a no-op — so a draft forked from a published node with N refs
 * lands with 0.
 *
 * Ordinary entity-reference fields (taxonomy, media, nodes, users) must not
 * require a revision id. Heuristic: resource types starting with `paragraph--`
 * are ERR targets and must resolve; anything else is left unchanged. An empty
 * `data` array is an explicit clear and is sent as-is.
 */

/**
 * Thrown when one or more paragraph identifiers cannot be given a
 * `target_revision_id`. The host write must not proceed.
 */
export class ErrRelationshipError extends Error {
  /**
   * @param {string} message Human-readable reason.
   * @param {{unresolved?: Array<{id: ?string, reason: string}>}} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "ErrRelationshipError";
    this.details = details;
  }
}

/**
 * Whether a JSON:API resource type is a paragraph bundle.
 * @param {*} type Resource type string, e.g. "paragraph--capability".
 * @returns {boolean}
 */
export function isParagraphResourceType(type) {
  return typeof type === "string" && type.startsWith("paragraph--");
}

/**
 * Split a JSON:API resource type into entity type + bundle.
 * @param {string} type e.g. "paragraph--capability".
 * @returns {?{entityType: string, bundle: string}}
 */
export function parseResourceType(type) {
  if (typeof type !== "string" || !type.includes("--")) return null;
  const [entityType, ...rest] = type.split("--");
  return { entityType, bundle: rest.join("--") };
}

/**
 * Prefer the vid on a just-created/updated paragraph (before a follow-up GET).
 * Fall back to an un-redacted GET when the write result did not carry it.
 * @param {object} backend Backend with `getEntity`.
 * @param {?object} paragraph Create/update result.
 * @param {string} bundle Paragraph type machine name.
 * @returns {Promise<?number>}
 */
export async function resolveParagraphRevisionId(backend, paragraph, bundle) {
  const fromWrite = paragraphRevisionId(paragraph);
  if (fromWrite !== null) return fromWrite;
  if (!paragraph?.id || typeof backend?.getEntity !== "function") return null;
  const fresh = await backend.getEntity({
    entityType: "paragraph",
    bundle: paragraph.bundle || bundle,
    id: paragraph.id,
  }).catch(() => null);
  return paragraphRevisionId(fresh);
}

/**
 * Error when a paragraph write succeeded but no revision id is readable.
 * Returning `{type, id}` would persist an empty ERR field (#192).
 * @param {string} id Paragraph UUID.
 * @param {"Created"|"Updated"} [operation="Created"] The write that already landed.
 * @returns {Error}
 */
export function missingParagraphRevisionError(id, operation = "Created") {
  const verb = operation === "Updated" ? "Updated" : "Created";
  return new Error(
    `${verb} paragraph ${id} but could not read drupal_internal__revision_id; ` +
    "refusing to return a relationship identifier Drupal would persist as empty (#192)."
  );
}

/**
 * Read `drupal_internal__revision_id` from a canonical entity (or a raw-ish
 * object that still carries the attribute at the top level).
 * @param {?object} entity
 * @returns {?number}
 */
export function paragraphRevisionId(entity) {
  if (!entity || typeof entity !== "object") return null;
  const fields = entity.fields && typeof entity.fields === "object" ? entity.fields : {};
  const raw = Object.prototype.hasOwnProperty.call(fields, "drupal_internal__revision_id")
    ? fields.drupal_internal__revision_id
    : entity.drupal_internal__revision_id;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the JSON:API resource identifier used to embed a paragraph in a host
 * ERR field. Includes `meta.target_revision_id` when a vid is known.
 * @param {string} bundle Paragraph type machine name.
 * @param {string} id Paragraph UUID.
 * @param {number|string|null|undefined} revisionId Current revision id.
 * @returns {{type: string, id: string, meta?: {target_revision_id: number}}}
 */
export function embedParagraphRef(bundle, id, revisionId) {
  const ref = { type: `paragraph--${bundle}`, id };
  if (revisionId === undefined || revisionId === null || revisionId === "") return ref;
  const n = Number(revisionId);
  if (!Number.isFinite(n)) return ref;
  ref.meta = { target_revision_id: n };
  return ref;
}

/**
 * Whether a resource identifier already carries a usable target revision id.
 * @param {?object} item
 * @returns {boolean}
 */
export function linkageHasRevisionMeta(item) {
  const vid = item?.meta?.target_revision_id;
  return vid !== undefined && vid !== null && vid !== "";
}

/**
 * Whether the caller supplied any relationship fields (including an explicit
 * empty-array clear). An omitted / empty object is "not sent".
 * @param {?object} relationships
 * @returns {boolean}
 */
export function relationshipsWereSent(relationships) {
  if (!relationships || typeof relationships !== "object" || Array.isArray(relationships)) {
    return false;
  }
  return Object.keys(relationships).length > 0;
}

/**
 * Clone a resource identifier, preserving `meta` when present.
 * @param {object} item
 * @returns {{type: *, id: *, meta?: object}}
 */
function cloneIdentifier(item) {
  const out = { type: item.type, id: item.id };
  if (item.meta && typeof item.meta === "object") out.meta = { ...item.meta };
  return out;
}

/**
 * Resolve one resource identifier. Paragraph refs without a vid are loaded
 * un-redacted and stamped with `meta.target_revision_id`. Failures are
 * recorded on `unresolved` rather than thrown so a mixed list is never
 * half-applied.
 * @param {object} backend Backend with `getEntity`.
 * @param {object} item Resource identifier.
 * @param {Map<string, number>} cache uuid → revision id (create-response vids).
 * @param {Array<{id: ?string, reason: string}>} unresolved
 * @returns {Promise<object>}
 */
async function resolveOneIdentifier(backend, item, cache, unresolved) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    unresolved.push({ id: null, reason: "malformed resource identifier" });
    return item;
  }
  if (typeof item.type !== "string" || typeof item.id !== "string") {
    unresolved.push({ id: item.id ?? null, reason: "resource identifier must include type and id" });
    return item;
  }

  const out = cloneIdentifier(item);

  // Ordinary entity-reference (taxonomy, media, node, user, file): leave alone.
  if (!isParagraphResourceType(item.type)) return out;

  if (linkageHasRevisionMeta(out)) {
    const n = Number(out.meta.target_revision_id);
    if (Number.isFinite(n)) {
      out.meta = { ...out.meta, target_revision_id: n };
      cache.set(item.id, n);
      return out;
    }
  }

  if (cache.has(item.id)) {
    out.meta = { ...(out.meta || {}), target_revision_id: cache.get(item.id) };
    return out;
  }

  const parsed = parseResourceType(item.type);
  if (!parsed) {
    unresolved.push({ id: item.id, reason: `unparseable type "${item.type}"` });
    return out;
  }

  let entity = null;
  try {
    entity = await backend.getEntity({
      entityType: parsed.entityType,
      bundle: parsed.bundle,
      id: item.id,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    unresolved.push({ id: item.id, reason: `GET failed: ${reason}` });
    return out;
  }
  if (!entity) {
    unresolved.push({ id: item.id, reason: "GET returned 404 / null" });
    return out;
  }

  const vid = paragraphRevisionId(entity);
  if (vid === null) {
    // Paragraphs are revisionable. A missing vid is a connector/backend gap,
    // not "not revisionable" — sending {type,id} would persist empty.
    unresolved.push({ id: item.id, reason: "paragraph has no drupal_internal__revision_id" });
    return out;
  }
  cache.set(item.id, vid);
  out.meta = { ...(out.meta || {}), target_revision_id: vid };
  return out;
}

/**
 * Inject `meta.target_revision_id` on every paragraph identifier in a
 * JSON:API relationships map. Throws before the caller PATCHes if any
 * paragraph ref cannot be resolved. Empty arrays and `data: null` pass
 * through (explicit clear). Non-paragraph refs are unchanged.
 *
 * @param {object} backend Backend with un-redacted `getEntity`.
 * @param {?object} relationships JSON:API relationships map.
 * @param {{revisionCache?: Map<string, number>}} [options]
 * @returns {Promise<?object>} A new relationships map, or the input when empty.
 * @throws {ErrRelationshipError} If any paragraph identifier cannot be resolved.
 */
export async function resolveErrRelationships(backend, relationships, options = {}) {
  if (relationships === null || relationships === undefined) return relationships;
  if (typeof relationships !== "object" || Array.isArray(relationships)) return relationships;

  const cache = options.revisionCache instanceof Map ? options.revisionCache : new Map();
  const unresolved = [];
  const entries = [];

  for (const [field, rel] of Object.entries(relationships)) {
    if (!rel || typeof rel !== "object" || !Object.prototype.hasOwnProperty.call(rel, "data")) {
      entries.push([field, rel]);
      continue;
    }
    const { data } = rel;
    if (data === null) {
      entries.push([field, { ...rel, data: null }]);
      continue;
    }
    if (Array.isArray(data)) {
      // Empty array is an explicit clear — do not resolve, do not fail.
      if (data.length === 0) {
        entries.push([field, { ...rel, data: [] }]);
        continue;
      }
      const items = [];
      for (const item of data) {
        items.push(await resolveOneIdentifier(backend, item, cache, unresolved));
      }
      entries.push([field, { ...rel, data: items }]);
      continue;
    }
    entries.push([field, { ...rel, data: await resolveOneIdentifier(backend, data, cache, unresolved) }]);
  }

  if (unresolved.length) {
    const listed = unresolved.map((u) => `${u.id ?? "(missing id)"}: ${u.reason}`).join("; ");
    throw new ErrRelationshipError(
      "Cannot attach paragraph relationship: failed to resolve target_revision_id " +
      `for ${unresolved.length} identifier(s). The write was not sent — an unresolved ` +
      `ERR identifier would persist an empty field. ${listed}`,
      { unresolved }
    );
  }
  return Object.fromEntries(entries);
}
