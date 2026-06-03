/**
 * Tool group: Taxonomy.
 *
 * Vocabulary discovery and term CRUD, backend-agnostic via resolveBackend. A
 * vocabulary is modelled as a bundle of the `taxonomy_term` entity type; reads
 * are redacted per the site security policy.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, redactCanonicalEntity } from "../lib/security.js";

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

/**
 * List all taxonomy vocabularies (bundles of the taxonomy_term entity type).
 *
 * @param {object} args - { site? }.
 * @returns {Promise<object[]>} Vocabulary bundle descriptors.
 */
async function listVocabularies({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  return backend.listBundles("taxonomy_term");
}

/**
 * List terms in a vocabulary, sorted by name, redacted per policy.
 *
 * @param {object} args - { site?, vocabulary, limit?, offset? }.
 * @returns {Promise<{total: number, approximate: boolean, terms: object[]}>}
 */
async function getTaxonomyTerms({ site: siteName, vocabulary, limit = 50, offset = 0 }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const res = await backend.listEntities({
    entityType: "taxonomy_term", bundle: vocabulary,
    sort: [{ field: "name", dir: "asc" }], page: { limit, offset },
  });
  return {
    total: res.page?.total ?? res.entities.length,
    approximate: res.approximate ?? false,
    terms: res.entities.map((e) => redactCanonicalEntity(e, sec, "taxonomy_term")),
  };
}

/**
 * Fetch a single taxonomy term by UUID, redacted per policy.
 *
 * @param {object} args - { site?, vocabulary, id }.
 * @returns {Promise<object|null>} The redacted term, or null if not found.
 */
async function getTaxonomyTerm({ site: siteName, vocabulary, id }) {
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  const backend = await resolveBackend(site);
  const entity = await backend.getEntity({ entityType: "taxonomy_term", bundle: vocabulary, id });
  return entity ? redactCanonicalEntity(entity, sec, "taxonomy_term") : null;
}

/**
 * Create a taxonomy term. The description is wrapped as a plain_text formatted
 * field; a parentId, if given, becomes a hierarchical `parent` relationship.
 *
 * @param {object} args - { site?, vocabulary, name, description?, weight?, parentId? }.
 * @returns {Promise<object>} The created term descriptor.
 */
async function createTaxonomyTerm({ site: siteName, vocabulary, name, description, weight = 0, parentId }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  const attributes = { name, weight };
  if (description !== undefined) attributes.description = { value: description, format: "plain_text" };
  const relationships = parentId
    ? { parent: { data: [{ type: `taxonomy_term--${vocabulary}`, id: parentId }] } }
    : undefined;
  return backend.createEntity({ entityType: "taxonomy_term", bundle: vocabulary, attributes, relationships });
}

/**
 * Update a term's name, description, and/or weight (partial — omitted fields
 * are left untouched).
 *
 * @param {object} args - { site?, vocabulary, id, name?, description?, weight? }.
 * @returns {Promise<object>} The updated term descriptor.
 */
async function updateTaxonomyTerm({ site: siteName, vocabulary, id, name, description, weight }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  const attributes = {};
  if (name !== undefined) attributes.name = name;
  if (weight !== undefined) attributes.weight = weight;
  if (description !== undefined) attributes.description = { value: description, format: "plain_text" };
  return backend.updateEntity({ entityType: "taxonomy_term", bundle: vocabulary, id, attributes });
}

/**
 * Delete a taxonomy term. Destructive-allowed assertion is applied upstream by
 * the security middleware.
 *
 * @param {object} args - { site?, vocabulary, id }.
 * @returns {Promise<{success: boolean, deletedId: string}>}
 */
async function deleteTaxonomyTerm({ site: siteName, vocabulary, id }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  await backend.deleteEntity({ entityType: "taxonomy_term", bundle: vocabulary, id });
  return { success: true, deletedId: id };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_list_vocabularies",
    description: "List all taxonomy vocabularies defined on this Drupal site.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
    },
  },
  {
    name: "drupal_get_taxonomy_terms",
    description: "List all terms in a taxonomy vocabulary, sorted by name.",
    inputSchema: {
      type: "object", required: ["vocabulary"],
      properties: {
        site:       { type: "string" },
        vocabulary: { type: "string", description: "Vocabulary machine name, e.g. 'tags'" },
        limit:      { type: "number", default: 50 },
        offset:     { type: "number", default: 0 },
      },
    },
  },
  {
    name: "drupal_get_taxonomy_term",
    description: "Fetch a single taxonomy term by UUID.",
    inputSchema: {
      type: "object", required: ["vocabulary", "id"],
      properties: {
        site:       { type: "string" },
        vocabulary: { type: "string" },
        id:         { type: "string", description: "Term UUID" },
      },
    },
  },
  {
    name: "drupal_create_taxonomy_term",
    description: "Create a new taxonomy term in a vocabulary.",
    inputSchema: {
      type: "object", required: ["vocabulary", "name"],
      properties: {
        site:        { type: "string" },
        vocabulary:  { type: "string" },
        name:        { type: "string" },
        description: { type: "string" },
        weight:      { type: "number", default: 0 },
        parentId:    { type: "string", description: "UUID of parent term (for hierarchical vocabularies)" },
      },
    },
  },
  {
    name: "drupal_update_taxonomy_term",
    description: "Update an existing taxonomy term's name, description, or weight.",
    inputSchema: {
      type: "object", required: ["vocabulary", "id"],
      properties: {
        site:        { type: "string" },
        vocabulary:  { type: "string" },
        id:          { type: "string" },
        name:        { type: "string" },
        description: { type: "string" },
        weight:      { type: "number" },
      },
    },
  },
  {
    name: "drupal_delete_taxonomy_term",
    description: "Delete a taxonomy term. Confirm with the user before calling.",
    inputSchema: {
      type: "object", required: ["vocabulary", "id"],
      properties: {
        site:       { type: "string" },
        vocabulary: { type: "string" },
        id:         { type: "string" },
      },
    },
  },
];

export const handlers = {
  drupal_list_vocabularies:     listVocabularies,
  drupal_get_taxonomy_terms:    getTaxonomyTerms,
  drupal_get_taxonomy_term:     getTaxonomyTerm,
  drupal_create_taxonomy_term:  createTaxonomyTerm,
  drupal_update_taxonomy_term:  updateTaxonomyTerm,
  drupal_delete_taxonomy_term:  deleteTaxonomyTerm,
};
