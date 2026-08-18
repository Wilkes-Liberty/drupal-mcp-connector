/**
 * Tool group: Paragraphs authoring helper.
 *
 * Paragraphs (the contrib Paragraphs module) are content-fragment entities of
 * the `paragraph` entity type, one bundle per paragraph type (e.g. `text`,
 * `image`, `cta`). They are NOT standalone content: a paragraph only appears on
 * a site when a *host* entity (usually a node) references it from an
 * Entity Reference Revisions (ERR) field. This module gives an authoring agent a
 * focused way to mint a paragraph and fetch it back, plus the relationship data
 * needed to embed it into a host field.
 *
 * Embedding model — IMPORTANT (#192):
 *   - Over JSON:API a host references a paragraph from its ERR field by a
 *     resource identifier `{ type: "paragraph--<bundle>", id, meta: {
 *     target_revision_id } }`. Drupal's ERR item is empty unless both
 *     `target_id` and `target_revision_id` are set; JSON:API only receives the
 *     revision id from `meta.target_revision_id`. `{ type, id }` alone persists
 *     an empty field — it is not a no-op, and it is worse than omitting the
 *     field (which would inherit the previous revision's refs).
 *   - `relationshipData` from these tools includes that meta key. Host writes
 *     (`drupal_entity_update` / `drupal_update_node` / bulk update) also resolve
 *     a missing vid before PATCH and fail the whole write if they cannot.
 *   - The classic entity-API pair `{ target_id, target_revision_id }` (integer
 *     ids) is the REST/Form-API shape, not the JSON:API shape.
 *   - Creating paragraphs and then attaching them is two calls. A content-tier
 *     agent cannot delete orphans if the host PATCH is then rejected (#201).
 *     Probe the host first: `drupal_list_revisions` (`possiblyPatchBlocked`)
 *     and `dryRun` on the host update. Preflight inside `update_node` does not
 *     un-orphan work that already happened.
 *
 * Both tools are governed: writes assert create permission for the `paragraph`
 * entity type + bundle, reads assert read permission and are redacted per the
 * site security policy. Writes default to whatever the backend default is for
 * the bundle (paragraphs have no independent publish status of their own).
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import {
  resolveSecurityConfig, assertWriteAllowed, assertReadAllowed, redactCanonicalEntity,
} from "../lib/security.js";
import { embedParagraphRef, paragraphRevisionId } from "../lib/err-relationships.js";

/**
 * Build the resource-identifier ref used to embed a paragraph in a host ERR /
 * paragraph reference field over JSON:API. Includes `meta.target_revision_id`
 * when a vid is known (#192).
 * @param {string} bundle Paragraph type machine name.
 * @param {string} id Paragraph UUID.
 * @param {number|string|null|undefined} [revisionId] Current revision id.
 * @returns {{type: string, id: string, meta?: {target_revision_id: number}}}
 */
export function embedRef(bundle, id, revisionId) {
  return embedParagraphRef(bundle, id, revisionId);
}

const EMBED_NOTE =
  "Paragraphs are not standalone content: embed this paragraph in a host entity's " +
  "Entity Reference Revisions (paragraph) field. Over JSON:API the resource identifier " +
  "MUST include meta.target_revision_id — Drupal's ERR item is empty unless both " +
  "target_id and target_revision_id are set, and JSON:API only receives the revision " +
  "id from that meta key. relationshipData from this tool includes it. " +
  "drupal_entity_update / drupal_update_node also resolve a missing vid before PATCH " +
  "and fail the write if they cannot. An empty array is an explicit clear. " +
  "Before creating paragraphs to attach to a published moderated node, call " +
  "drupal_list_revisions (inspect possiblyPatchBlocked) and dryRun the host update — " +
  "the host write is rejected after dependents exist, and content-tier cannot delete " +
  "the orphans (#201).";

/**
 * Prefer the vid on a just-created/updated paragraph (before a follow-up GET).
 * Fall back to an un-redacted GET when the write result did not carry it.
 * @param {object} backend
 * @param {object} paragraph
 * @param {string} paragraphType
 * @returns {Promise<?number>}
 */
async function revisionIdFrom(backend, paragraph, paragraphType) {
  const fromWrite = paragraphRevisionId(paragraph);
  if (fromWrite !== null) return fromWrite;
  if (!paragraph?.id) return null;
  const fresh = await backend.getEntity({
    entityType: "paragraph",
    bundle: paragraph.bundle || paragraphType,
    id: paragraph.id,
  }).catch(() => null);
  return paragraphRevisionId(fresh);
}

/**
 * Create a paragraph entity of the given type and return a ref suitable for
 * embedding it in a host entity's paragraph/ERR field.
 *
 * @param {object} args - { site?, paragraphType, attributes? }.
 *   `attributes` are paragraph field values keyed by Drupal machine name
 *   (e.g. { field_body: { value, format } }). Use drupal_get_entity_schema for
 *   entityType "paragraph" + the bundle to discover available fields.
 * @returns {Promise<{paragraph: object, ref: object, relationshipData: object, note: string}>}
 *   The created paragraph descriptor plus the embedding ref/relationship data
 *   (including `meta.target_revision_id`).
 * @throws {SecurityError} If creating paragraphs of this bundle is not permitted.
 * @throws {Error} If the created paragraph has no readable revision id.
 */
async function createParagraph({ site: siteName, paragraphType, attributes = {} }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "create", "paragraph", paragraphType);
  const backend = await resolveBackend(site);
  const paragraph = await backend.createEntity({ entityType: "paragraph", bundle: paragraphType, attributes });
  const bundle = paragraph.bundle || paragraphType;
  const revisionId = await revisionIdFrom(backend, paragraph, paragraphType);
  if (revisionId === null) {
    throw new Error(
      `Created paragraph ${paragraph.id} but could not read drupal_internal__revision_id; ` +
      "refusing to return a relationship identifier Drupal would persist as empty (#192)."
    );
  }
  const ref = embedRef(bundle, paragraph.id, revisionId);
  return { paragraph, ref, relationshipData: ref, note: EMBED_NOTE };
}

/**
 * Update an existing paragraph's field values. Mirrors createParagraph but
 * targets an existing paragraph by UUID via a partial JSON:API PATCH, so only
 * the supplied attributes are changed. The host entity's reference to the
 * paragraph is unaffected (same UUID), so updating a paragraph in place is the
 * way to maintain component / key-capability paragraphs without re-embedding.
 *
 * @param {object} args - { site?, paragraphType, id, attributes? }.
 *   `attributes` are the paragraph field values to change, keyed by Drupal
 *   machine name (e.g. { field_body: { value, format } }).
 * @returns {Promise<{paragraph: object, ref: object, relationshipData: object, note: string}>}
 *   The updated paragraph plus the embedding ref (with current revision id).
 * @throws {Error} If id is missing or the revision id cannot be read.
 * @throws {SecurityError} If updating paragraphs of this bundle is not permitted.
 */
async function updateParagraph({ site: siteName, paragraphType, id, attributes = {} }) {
  if (!id) throw new Error("A paragraph 'id' (UUID) is required to update an existing paragraph.");
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", "paragraph", paragraphType);
  const backend = await resolveBackend(site);
  const paragraph = await backend.updateEntity({ entityType: "paragraph", bundle: paragraphType, id, attributes });
  const bundle = paragraph.bundle || paragraphType;
  const revisionId = await revisionIdFrom(backend, paragraph, paragraphType);
  if (revisionId === null) {
    throw new Error(
      `Updated paragraph ${id} but could not read drupal_internal__revision_id; ` +
      "refusing to return a relationship identifier Drupal would persist as empty (#192)."
    );
  }
  const ref = embedRef(bundle, paragraph.id, revisionId);
  return { paragraph, ref, relationshipData: ref, note: EMBED_NOTE };
}

/**
 * Fetch a single paragraph by bundle + UUID, redacted per the site policy, and
 * annotate it with the embedding ref (including `meta.target_revision_id`).
 *
 * @param {object} args - { site?, paragraphType, id }.
 * @returns {Promise<(object & {ref: object})|null>}
 *   The redacted paragraph with an embedding `ref`, or null if not found.
 * @throws {SecurityError} If reading paragraphs of this bundle is not permitted.
 */
async function getParagraph({ site: siteName, paragraphType, id }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "paragraph", paragraphType);
  const backend = await resolveBackend(site);
  const entity = await backend.getEntity({ entityType: "paragraph", bundle: paragraphType, id });
  if (!entity) return null;
  const redacted = redactCanonicalEntity(entity, sec, "paragraph");
  const revisionId = paragraphRevisionId(entity) ?? paragraphRevisionId(redacted);
  return { ...redacted, ref: embedRef(redacted.bundle || paragraphType, redacted.id, revisionId) };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_create_paragraph",
    description:
      "Create a Paragraph entity of a given paragraph type (bundle). Paragraphs are content fragments that are NOT standalone — they must be referenced by a host entity's paragraph / Entity Reference Revisions field. Returns the created paragraph plus `relationshipData` ({ type: 'paragraph--<bundle>', id, meta: { target_revision_id } }) to drop into a host field's relationships via drupal_entity_update / drupal_update_node. Drupal ERR items are empty without that meta key — do not send {type, id} alone. Before creating paragraphs to attach to a published moderated node, call drupal_list_revisions (possiblyPatchBlocked) and dryRun the host update so a doomed PATCH does not orphan them. Use drupal_get_entity_schema (entityType 'paragraph', the bundle) first to discover fields. Governed by the site security policy.",
    inputSchema: {
      type: "object", required: ["paragraphType"],
      properties: {
        site:          { type: "string", description: "Named site (omit for default)" },
        paragraphType: { type: "string", description: "Paragraph type / bundle machine name, e.g. 'text', 'image', 'cta'" },
        attributes:    { type: "object", description: "Paragraph field values keyed by Drupal machine name, e.g. { field_body: { value: '<p>..</p>', format: 'full_html' } }" },
      },
    },
  },
  {
    name: "drupal_update_paragraph",
    description:
      "Update an existing Paragraph entity's field values by paragraph type (bundle) and UUID. Only the attributes you pass are changed (partial update); the host entity's reference to the paragraph is unchanged (same UUID), so this maintains a component paragraph in place without re-embedding. Returns relationshipData including meta.target_revision_id for a later host attach. Use drupal_get_entity_schema (entityType 'paragraph', the bundle) to discover fields. Governed by the site security policy.",
    inputSchema: {
      type: "object", required: ["paragraphType", "id"],
      properties: {
        site:          { type: "string", description: "Named site (omit for default)" },
        paragraphType: { type: "string", description: "Paragraph type / bundle machine name, e.g. 'text', 'image', 'cta'" },
        id:            { type: "string", description: "Paragraph UUID" },
        attributes:    { type: "object", description: "Paragraph field values to change, keyed by Drupal machine name, e.g. { field_body: { value: '<p>..</p>', format: 'full_html' } }" },
      },
    },
  },
  {
    name: "drupal_get_paragraph",
    description:
      "Fetch a single Paragraph entity by paragraph type (bundle) and UUID. Returns the redacted paragraph (fields include drupal_internal__revision_id) plus a `ref` ({ type: 'paragraph--<bundle>', id, meta: { target_revision_id } }) you can use to embed it in a host entity's paragraph / ERR field. Paragraphs are referenced from a host field rather than queried standalone in production. Governed by the site security policy.",
    inputSchema: {
      type: "object", required: ["paragraphType", "id"],
      properties: {
        site:          { type: "string" },
        paragraphType: { type: "string", description: "Paragraph type / bundle machine name" },
        id:            { type: "string", description: "Paragraph UUID" },
      },
    },
  },
];

export const handlers = {
  drupal_create_paragraph: createParagraph,
  drupal_update_paragraph: updateParagraph,
  drupal_get_paragraph:    getParagraph,
};
