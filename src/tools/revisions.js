/**
 * Tool group: Entity revisions.
 *
 * Read and revert entity revisions via JSON:API's `?resourceVersion=` mechanism
 * (Drupal 9.3+). JSON:API does NOT expose a full enumerable revision history per
 * entity — it only addresses individual versions by id (`id:<vid>`) or by the
 * relative aliases `rel:latest-version` and `rel:working-copy`. So:
 *
 *   - drupal_list_revisions surfaces the latest default revision and the
 *     working-copy (forward) revision plus their links, and clearly notes that
 *     full chronological history enumeration requires the Drush bridge.
 *   - drupal_get_revision fetches one specific version (by vid or alias).
 *   - drupal_revert_revision is a GOVERNED WRITE: it reads the target revision
 *     and replays its editable attributes through updateEntity to make them the
 *     new current revision (assertWriteAllowed gates it; internal/immutable
 *     bookkeeping fields are never written back).
 *
 * Reads are redacted per the site's security policy.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import {
  resolveSecurityConfig, assertReadAllowed, assertWriteAllowed,
} from "../lib/security.js";

// Attributes that describe the entity's identity / revision bookkeeping / paths.
// These are read-only or server-managed and must NOT be replayed on a revert.
// (drupal_internal__* internal ids, the revision metadata, and computed path.)
const NON_RESTORABLE_ATTRS = new Set([
  "drupal_internal__nid",
  "drupal_internal__vid",
  "drupal_internal__tid",
  "drupal_internal__id",
  "drupal_internal__revision_id",
  "vid",
  "revision_timestamp",
  "revision_uid",
  "revision_default",
  "revision_translation_affected",
  "changed",
  "created",
  "uuid",
  "path",
  "default_langcode",
  "content_translation_source",
  "content_translation_outdated",
]);

const REVISION_VALUE_RE = /^id:.+$/;

/**
 * Build the JSON:API `?resourceVersion=` query string for a requested version.
 * Accepts a numeric/string vid (-> `id:<vid>`), an explicit `id:<vid>` string,
 * or the relative aliases `rel:latest-version` / `rel:working-copy`. The value
 * is URL-encoded so the `:` becomes `%3A` (JSON:API requires the encoded form).
 *
 * @param {string|number} version Requested version selector.
 * @returns {string} A query string fragment, e.g. "resourceVersion=id%3A42".
 * @throws {Error} If the selector is not a recognized form.
 */
function resourceVersionParam(version) {
  let selector;
  if (typeof version === "number") {
    selector = `id:${version}`;
  } else if (typeof version === "string" && version.length) {
    if (version === "rel:latest-version" || version === "rel:working-copy") {
      selector = version;
    } else if (REVISION_VALUE_RE.test(version)) {
      selector = version;
    } else if (/^\d+$/.test(version)) {
      selector = `id:${version}`;
    } else {
      throw new Error(
        `Invalid revision version "${version}". Use a numeric vid, "id:<vid>", ` +
        "\"rel:latest-version\", or \"rel:working-copy\"."
      );
    }
  } else {
    throw new Error("A revision version selector is required.");
  }
  return `resourceVersion=${encodeURIComponent(selector)}`;
}

/**
 * Fetch a single revision's raw JSON:API resource for an entity.
 * Path construction reuses the backend's own validation (machine names / UUID),
 * so traversal-style ids are rejected upstream.
 *
 * @param {object} backend Resolved backend.
 * @param {string} entityType Entity type machine name.
 * @param {string} bundle Bundle machine name.
 * @param {string} id Entity UUID.
 * @param {string|number} version Version selector (see resourceVersionParam).
 * @returns {Promise<?object>} The raw JSON:API resource object, or null.
 */
async function fetchRevisionResource(backend, entityType, bundle, id, version) {
  const path = `${backend.resourcePath(entityType, bundle)}/${encodeURIComponent(id)}?${resourceVersionParam(version)}`;
  const res = await backend.rawQuery({ path });
  return res?.data ?? null;
}

/**
 * Shape a raw JSON:API revision resource into a compact, descriptor.
 *
 * @param {?object} resource Raw JSON:API resource object.
 * @returns {?object} { vid, revisionTimestamp, revisionLog, status, links, attributes, relationships }.
 */
function summarizeRevision(resource) {
  if (!resource) return null;
  const attrs = new Map(Object.entries(resource.attributes ?? {}));
  return {
    vid: attrs.get("drupal_internal__vid") ?? null,
    revisionTimestamp: attrs.get("revision_timestamp") ?? null,
    revisionLog: attrs.get("revision_log") ?? attrs.get("revision_log_message") ?? null,
    status: attrs.get("status") ?? null,
    title: attrs.get("title") ?? null,
    links: resource.links ?? null,
  };
}

/**
 * List the addressable revisions of an entity: the latest default revision and
 * the working-copy (forward) revision. Full chronological enumeration is not
 * possible through JSON:API alone, so this returns what IS reachable and notes
 * that the Drush bridge is required for the complete history.
 *
 * @param {object} args - { site?, type, id }.
 * @returns {Promise<object>} latest/working-copy descriptors plus a capability note.
 * @throws {SecurityError} If reading nodes/bundle is not permitted.
 */
async function listRevisions({ site: siteName, type, id }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);

  const latestVersion = await fetchRevisionResource(backend, "node", type, id, "rel:latest-version")
    .then(summarizeRevision)
    .catch(() => null);

  // The working-copy alias only resolves on entities under a content_moderation
  // workflow with a pending forward revision; absence is expected, not an error.
  const workingCopy = await fetchRevisionResource(backend, "node", type, id, "rel:working-copy")
    .then(summarizeRevision)
    .catch(() => null);

  return {
    entityType: "node",
    bundle: type,
    id,
    latestVersion,
    workingCopy,
    fullHistoryAvailable: false,
    note:
      "JSON:API only addresses revisions by id (id:<vid>) or the rel:latest-version / " +
      "rel:working-copy aliases; it cannot enumerate the full chronological history. " +
      "Use drupal_get_revision with a specific vid to inspect a known revision, or the " +
      "Drush bridge for complete revision-history enumeration. " +
      "drupal_report_revision_hotspots can surface per-node revision counts.",
  };
}

/**
 * Fetch a single revision of an entity by vid or relative alias. Read-only;
 * the returned attributes are redacted per the site's security policy.
 *
 * @param {object} args - { site?, type, id, version }.
 *   `version` is a numeric vid, "id:<vid>", "rel:latest-version", or "rel:working-copy".
 * @returns {Promise<?object>} The revision descriptor, or null if not found.
 * @throws {SecurityError} If reading nodes/bundle is not permitted.
 */
async function getRevision({ site: siteName, type, id, version }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);

  const resource = await fetchRevisionResource(backend, "node", type, id, version);
  if (!resource) return null;

  const summary = summarizeRevision(resource);
  const fieldsToRedact = new Set([
    ...(sec.globalRedactedFields ?? []),
    ...(new Map(Object.entries(sec.entityRules ?? {})).get("node")?.redactedFields ?? []),
  ]);
  const attributes = Object.fromEntries(
    Object.entries(resource.attributes ?? {}).map(([k, v]) => [k, fieldsToRedact.has(k) ? "[REDACTED]" : v])
  );

  return {
    entityType: "node",
    bundle: type,
    id,
    vid: summary.vid,
    revisionTimestamp: summary.revisionTimestamp,
    revisionLog: summary.revisionLog,
    status: summary.status,
    attributes,
    relationships: resource.relationships ?? {},
    links: resource.links ?? null,
  };
}

/**
 * Revert an entity to a prior revision (GOVERNED WRITE). Reads the target
 * revision, then replays its editable attributes through updateEntity so they
 * become the new current revision. Internal/immutable bookkeeping fields
 * (drupal_internal__*, revision metadata, computed path, timestamps) are
 * stripped before the write so only restorable content is sent.
 *
 * This does not delete any history — the revert produces a NEW revision whose
 * content matches the target, preserving the audit trail.
 *
 * @param {object} args - { site?, type, id, version }.
 *   `version` is a numeric vid, "id:<vid>", "rel:latest-version", or "rel:working-copy".
 * @returns {Promise<{success: boolean, id: string, entityType: string, bundle: string,
 *   revertedFrom: (number|string), restoredFields: string[]}>}
 * @throws {SecurityError} If updating nodes/bundle is not permitted.
 * @throws {Error} If the target revision cannot be read.
 */
async function revertRevision({ site: siteName, type, id, version }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  // Governed write: revert is an update of the entity to a prior state.
  assertWriteAllowed(sec, "update", "node", type);
  const backend = await resolveBackend(site);

  const resource = await fetchRevisionResource(backend, "node", type, id, version);
  if (!resource) {
    throw new Error(
      `Could not read revision "${version}" of node/${type}/${id} to revert from.`
    );
  }

  // Replay only restorable, content-bearing attributes. Skip internal ids,
  // revision bookkeeping, the computed path, and redacted fields (never write
  // back a value the policy would have hidden).
  const fieldsToRedact = new Set([
    ...(sec.globalRedactedFields ?? []),
    ...(new Map(Object.entries(sec.entityRules ?? {})).get("node")?.redactedFields ?? []),
  ]);
  const attributes = Object.fromEntries(
    Object.entries(resource.attributes ?? {}).filter(
      ([k]) => !NON_RESTORABLE_ATTRS.has(k) && !fieldsToRedact.has(k)
    )
  );

  await backend.updateEntity({ entityType: "node", bundle: type, id, attributes });

  return {
    success: true,
    id,
    entityType: "node",
    bundle: type,
    revertedFrom: typeof version === "number" ? version : (summarizeRevision(resource).vid ?? version),
    restoredFields: Object.keys(attributes),
  };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_list_revisions",
    description:
      "Surface the addressable revisions of a content node: the latest default revision and the working-copy (forward) revision, with their version ids and links. NOTE: JSON:API cannot enumerate full chronological revision history — it only addresses revisions by id or the latest/working-copy aliases. Full history enumeration requires the Drush bridge. Use drupal_report_revision_hotspots for per-node revision counts.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site: { type: "string", description: "Named site (omit for default)" },
        type: { type: "string", description: "Content type machine name, e.g. 'article'" },
        id:   { type: "string", description: "Node UUID" },
      },
    },
  },
  {
    name: "drupal_get_revision",
    description:
      "Fetch a single revision of a content node by version id or alias. `version` may be a numeric vid (e.g. 42), an explicit 'id:<vid>', or the relative aliases 'rel:latest-version' / 'rel:working-copy'. Read-only; attributes are redacted per security policy.",
    inputSchema: {
      type: "object", required: ["type", "id", "version"],
      properties: {
        site:    { type: "string" },
        type:    { type: "string", description: "Content type machine name" },
        id:      { type: "string", description: "Node UUID" },
        version: {
          type: ["string", "number"],
          description: "Numeric vid, 'id:<vid>', 'rel:latest-version', or 'rel:working-copy'.",
        },
      },
    },
  },
  {
    name: "drupal_revert_revision",
    description:
      "Revert a content node to a prior revision (GOVERNED WRITE). Reads the target revision and replays its editable content as a NEW current revision (history is preserved, nothing is deleted). Internal ids, revision metadata, and computed paths are not written back. Subject to the site's write security policy. Confirm with the user before calling.",
    inputSchema: {
      type: "object", required: ["type", "id", "version"],
      properties: {
        site:    { type: "string" },
        type:    { type: "string", description: "Content type machine name" },
        id:      { type: "string", description: "Node UUID" },
        version: {
          type: ["string", "number"],
          description: "Revision to restore: numeric vid, 'id:<vid>', 'rel:latest-version', or 'rel:working-copy'.",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handler map
// ---------------------------------------------------------------------------

export const handlers = {
  drupal_list_revisions:  listRevisions,
  drupal_get_revision:    getRevision,
  drupal_revert_revision: revertRevision,
};
