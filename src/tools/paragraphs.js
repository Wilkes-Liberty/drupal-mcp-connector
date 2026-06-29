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
 * Embedding model — IMPORTANT:
 *   - Over JSON:API (this connector's default backend) a host references a
 *     paragraph from its ERR field by a resource identifier object
 *     `{ type: "paragraph--<bundle>", id: "<paragraph-uuid>" }`. Drupal resolves
 *     the correct target_id + target_revision_id server-side from the UUID. Drop
 *     `relationshipData` (returned by drupal_create_paragraph) into the host's
 *     relationships map and call drupal_entity_update / drupal_update_node.
 *   - The classic entity-API pair `{ target_id, target_revision_id }` (integer
 *     ids) is the REST/Form-API shape, not the JSON:API shape. Those numeric ids
 *     are not surfaced by the canonical entity here; prefer the UUID relationship
 *     form above when writing through this connector.
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

/**
 * Build the JSON:API resource type string for a paragraph bundle.
 * @param {string} bundle Paragraph type machine name.
 * @returns {string} e.g. "paragraph--text".
 */
function resourceType(bundle) {
  return `paragraph--${bundle}`;
}

/**
 * Build the resource-identifier ref used to embed a paragraph in a host ERR /
 * paragraph reference field over JSON:API.
 * @param {string} bundle Paragraph type machine name.
 * @param {string} id Paragraph UUID.
 * @returns {{type: string, id: string}}
 */
function embedRef(bundle, id) {
  return { type: resourceType(bundle), id };
}

const EMBED_NOTE =
  "Paragraphs are not standalone content: embed this paragraph in a host entity's " +
  "Entity Reference Revisions (paragraph) field. Over JSON:API, add `relationshipData` " +
  "to the host field's relationship (e.g. drupal_entity_update / drupal_update_node with " +
  "relationships: { field_paragraphs: { data: [ relationshipData ] } }). Drupal resolves " +
  "target_id + target_revision_id from the UUID server-side.";

/**
 * Create a paragraph entity of the given type and return a ref suitable for
 * embedding it in a host entity's paragraph/ERR field.
 *
 * @param {object} args - { site?, paragraphType, attributes? }.
 *   `attributes` are paragraph field values keyed by Drupal machine name
 *   (e.g. { field_body: { value, format } }). Use drupal_get_entity_schema for
 *   entityType "paragraph" + the bundle to discover available fields.
 * @returns {Promise<{paragraph: object, ref: {id: string, type: string},
 *   relationshipData: {type: string, id: string}, note: string}>}
 *   The created paragraph descriptor plus the embedding ref/relationship data.
 * @throws {SecurityError} If creating paragraphs of this bundle is not permitted.
 */
async function createParagraph({ site: siteName, paragraphType, attributes = {} }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "create", "paragraph", paragraphType);
  const backend = await resolveBackend(site);
  const paragraph = await backend.createEntity({ entityType: "paragraph", bundle: paragraphType, attributes });
  const bundle = paragraph.bundle || paragraphType;
  const ref = embedRef(bundle, paragraph.id);
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
 * @returns {Promise<{paragraph: object, ref: {id: string, type: string},
 *   relationshipData: {type: string, id: string}, note: string}>}
 *   The updated paragraph plus the (unchanged) embedding ref.
 * @throws {Error} If id is missing.
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
  const ref = embedRef(bundle, paragraph.id);
  return { paragraph, ref, relationshipData: ref, note: EMBED_NOTE };
}

/**
 * Fetch a single paragraph by bundle + UUID, redacted per the site policy, and
 * annotate it with the embedding ref.
 *
 * @param {object} args - { site?, paragraphType, id }.
 * @returns {Promise<(object & {ref: {id: string, type: string}})|null>}
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
  return { ...redacted, ref: embedRef(redacted.bundle || paragraphType, redacted.id) };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_create_paragraph",
    description:
      "Create a Paragraph entity of a given paragraph type (bundle). Paragraphs are content fragments that are NOT standalone — they must be referenced by a host entity's paragraph / Entity Reference Revisions field. Returns the created paragraph plus `relationshipData` ({ type: 'paragraph--<bundle>', id: <uuid> }) to drop into a host field's relationships via drupal_entity_update / drupal_update_node. Use drupal_get_entity_schema (entityType 'paragraph', the bundle) first to discover fields. Governed by the site security policy.",
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
      "Update an existing Paragraph entity's field values by paragraph type (bundle) and UUID. Only the attributes you pass are changed (partial update); the host entity's reference to this paragraph is unchanged (same UUID), so this maintains a component paragraph in place without re-embedding. Use drupal_get_entity_schema (entityType 'paragraph', the bundle) to discover fields. Governed by the site security policy.",
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
      "Fetch a single Paragraph entity by paragraph type (bundle) and UUID. Returns the redacted paragraph plus a `ref` ({ type: 'paragraph--<bundle>', id }) you can use to embed it in a host entity's paragraph / ERR field. Note: paragraphs are referenced (by target_id + target_revision_id in the entity API, or by UUID over JSON:API) from a host field rather than queried standalone in production. Governed by the site security policy.",
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
