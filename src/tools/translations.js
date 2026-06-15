/**
 * Tool group: Content translations (multilingual / content_translation).
 *
 * Drupal core JSON:API does not model translations as standalone resources —
 * a translatable entity carries a `langcode` attribute and Drupal serves the
 * negotiated/default-language variant of a resource at its canonical path. To
 * surface multilingual handling cleanly we expose:
 *
 *   - drupal_list_translations  — read the entity and report its langcode(s).
 *   - drupal_create_translation — governed write: set/replace a translation by
 *     PATCHing the entity with the target `langcode` plus the supplied fields.
 *
 * Requirements (server side):
 *   - The Drupal `content_translation` module must be enabled and the target
 *     entity type/bundle configured as translatable, otherwise create attempts
 *     are rejected by Drupal and listing only ever reports the single language.
 *
 * Limitation: core JSON:API exposes the resource in one language at a time and
 * does not enumerate every available translation as a distinct resource. This
 * module therefore reports the langcode(s) it can observe on the returned
 * resource. Enumerating ALL translations of an entity requires either the
 * contrib "JSON:API Translation" module or the Drush bridge, neither of which
 * is assumed here — see the `note` field on the list result.
 *
 * Reads are redacted per the site security policy; the create path is a
 * governed write (asserts the "update" operation — a translation is a facet of
 * an existing entity, not a new entity).
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import {
  resolveSecurityConfig, assertReadAllowed, assertWriteAllowed, redactCanonicalEntity,
} from "../lib/security.js";
import { validateUuid, validateMachineName } from "../lib/validate.js";

const LIST_NOTE =
  "Core JSON:API serves one language per resource and does not enumerate every " +
  "translation. langcodes reflects only the language(s) observable on the fetched " +
  "resource. Full enumeration requires the JSON:API Translation contrib module or " +
  "the Drush bridge. Creating translations requires content_translation enabled and " +
  "the bundle configured as translatable.";

/**
 * List the translation langcode(s) observable for an entity.
 *
 * Reads the entity through the backend's validated rawQuery (so path segments
 * are checked and content_moderation handling is reused) and reports its
 * `langcode`. The entity type defaults to "node"; pass `entityType` for others.
 *
 * @param {object} args - { site?, entityType?, type, id }.
 *   `type` is the bundle machine name; `entityType` defaults to "node".
 * @returns {Promise<object|null>} A translation summary, or null if not found.
 * @throws {SecurityError} If reading the type/bundle is not permitted.
 */
async function listTranslations({ site: siteName, entityType = "node", type, id }) {
  validateMachineName(entityType, "entityType");
  validateMachineName(type, "type");
  validateUuid(id);

  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, type);

  const backend = await resolveBackend(site);
  const res = await backend.rawQuery({ path: `/jsonapi/${entityType}/${type}/${id}` });
  const data = res?.data;
  if (!data) return null;

  const defaultLangcode = data.attributes?.langcode ?? null;
  const langcodes = defaultLangcode ? [defaultLangcode] : [];
  const translations = langcodes.map((lc) => ({ langcode: lc, default: lc === defaultLangcode }));

  return {
    id: data.id,
    entityType,
    bundle: type,
    defaultLangcode,
    langcodes,
    translations,
    note: LIST_NOTE,
  };
}

/**
 * Create (or replace) a translation of an entity for a target language.
 *
 * Governed write. Implemented as a PATCH (via the backend's updateEntity) that
 * sets the target `langcode` alongside the supplied attributes. With
 * content_translation enabled and the bundle marked translatable, Drupal stores
 * the supplied fields against the requested language. If the bundle is not
 * translatable, Drupal rejects the write and the error surfaces to the caller.
 *
 * The result is redacted per the site policy.
 *
 * @param {object} args - { site?, entityType?, type, id, langcode, attributes? }.
 *   `type` is the bundle; `entityType` defaults to "node"; `langcode` is the
 *   target language (e.g. "de"); `attributes` are the translated field values.
 * @returns {Promise<object>} The updated/redacted entity descriptor.
 * @throws {SecurityError} If writing the type/bundle is not permitted.
 * @throws {Error} If langcode/id/type are invalid, or Drupal rejects the write.
 */
async function createTranslation({ site: siteName, entityType = "node", type, id, langcode, attributes = {} }) {
  validateMachineName(entityType, "entityType");
  validateMachineName(type, "type");
  validateUuid(id);
  // langcode is interpolated into the JSON:API payload and selects the language
  // variant; validate it as a machine-name-like token (e.g. "en", "pt_br",
  // "zh_hans") to block injection / malformed values.
  validateMachineName(langcode, "langcode");

  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  // A translation is a facet of an existing entity → "update", not "create".
  assertWriteAllowed(sec, "update", entityType, type);

  const backend = await resolveBackend(site);
  const updated = await backend.updateEntity({
    entityType,
    bundle: type,
    id,
    attributes: { ...attributes, langcode },
  });
  return redactCanonicalEntity(updated, sec, entityType);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_list_translations",
    description:
      "List the translation langcode(s) for a Drupal entity (multilingual / content_translation). " +
      "Reports the language(s) observable on the resource. Core JSON:API serves one language per " +
      "resource and does not enumerate all translations — see the returned note. Defaults to node.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site:       { type: "string", description: "Named site (omit for default)" },
        entityType: { type: "string", description: "Entity type machine name. Default: 'node'." },
        type:       { type: "string", description: "Bundle machine name, e.g. 'article'" },
        id:         { type: "string", description: "Entity UUID" },
      },
    },
  },
  {
    name: "drupal_create_translation",
    description:
      "Create or replace a translation of a Drupal entity for a target language (governed write). " +
      "Sets the given langcode plus the supplied translated field values. Requires the content_translation " +
      "module enabled and the bundle configured as translatable; otherwise Drupal rejects the write. " +
      "Defaults to node.",
    inputSchema: {
      type: "object", required: ["type", "id", "langcode"],
      properties: {
        site:       { type: "string" },
        entityType: { type: "string", description: "Entity type machine name. Default: 'node'." },
        type:       { type: "string", description: "Bundle machine name, e.g. 'article'" },
        id:         { type: "string", description: "Entity UUID" },
        langcode:   { type: "string", description: "Target language code, e.g. 'de', 'fr', 'pt_br'" },
        attributes: { type: "object", description: "Translated field values keyed by Drupal machine name" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Handler map
// ---------------------------------------------------------------------------

export const handlers = {
  drupal_list_translations:  listTranslations,
  drupal_create_translation: createTranslation,
};
