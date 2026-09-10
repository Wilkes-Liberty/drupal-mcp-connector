/**
 * Tool group: Content translations (multilingual / content_translation).
 *
 * Core JSON:API does not add a translation by PATCHing `langcode` on the
 * canonical entity — that mutates the default language. Governed node
 * translations go through Sentinel's draft-translation surface:
 *
 *   - drupal_list_translations  — inventory of live and working languages
 *   - drupal_create_translation — add a language as an unpublished forward draft
 *
 * Continuation of an existing unpublished translation is drupal_update_node
 * with `langcode`. Reads of that draft are drupal_get_node / drupal_get_revision
 * with `langcode`.
 *
 * Paragraph field-value translation is not supported on this path. Shared
 * structure (references, files, aliases) stays on the source language.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import {
  resolveSecurityConfig, assertReadAllowed, assertWriteAllowed, assertPublishAllowed,
  redactCanonicalEntity,
} from "../lib/security.js";
import { validateUuid, validateMachineName } from "../lib/validate.js";
import { applySafeDraftDefault } from "../lib/moderation-default.js";
import { loadWorkingCopy } from "../lib/patch-preflight.js";
import { entityRevisionId } from "../lib/write-revision.js";
import {
  assertDraftLangcode,
  createTranslationDraft,
  readTranslationInventory,
} from "../lib/draft-write.js";

const LIST_NOTE =
  "Live languages are those on the default revision. Working languages are the " +
  "unpublished forward revision when the principal can view it. Core JSON:API " +
  "alone cannot enumerate translations; this inventory requires Sentinel's " +
  "mcp-translations endpoint.";

const FALLBACK_NOTE =
  "Sentinel's translation inventory is unavailable. Core JSON:API served one " +
  "language for this resource; it does not prove other translations are absent.";

/**
 * List live and working translation langcodes for an entity.
 *
 * @param {object} args - { site?, entityType?, type, id }.
 * @returns {Promise<object|null>} A translation summary, or null if not found.
 */
async function listTranslations({ site: siteName, entityType = "node", type, id }) {
  validateMachineName(entityType, "entityType");
  validateMachineName(type, "type");
  validateUuid(id);

  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, entityType, type);

  const backend = await resolveBackend(site);
  if (entityType === "node" && typeof backend.rawQuery === "function") {
    try {
      const meta = await readTranslationInventory(backend, { entityType, bundle: type, id });
      const liveLangs = (meta.live?.translations ?? []).map((row) => row.langcode);
      const workingLangs = (meta.working?.translations ?? []).map((row) => row.langcode);
      const langcodes = [...new Set([...liveLangs, ...workingLangs])];
      return {
        id,
        entityType,
        bundle: type,
        defaultLangcode: meta.defaultLangcode ?? liveLangs[0] ?? null,
        langcodes,
        live: meta.live ?? null,
        working: meta.working ?? null,
        translations: (meta.working?.translations ?? meta.live?.translations ?? []).map((row) => ({
          langcode: row.langcode,
          default: Boolean(row.default),
          status: row.status,
          title: row.title,
          moderation_state: row.moderation_state,
        })),
        note: LIST_NOTE,
      };
    } catch (error) {
      if (!/does not provide Sentinel's governed draft-translation endpoint/.test(String(error?.message))) {
        throw error;
      }
    }
  }

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
    note: FALLBACK_NOTE,
  };
}

/**
 * Create a translation as an unpublished non-default draft revision.
 *
 * Does not PATCH canonical langcode. Requires Sentinel's translation endpoint.
 * An existing translation is a conflict. English live fields stay unchanged.
 *
 * @param {object} args - { site?, entityType?, type, id, langcode, attributes? }.
 * @returns {Promise<object>} The created translation, redacted.
 */
async function createTranslation({
  site: siteName, entityType = "node", type, id, langcode, attributes = {}, dryRun = false,
}) {
  validateMachineName(entityType, "entityType");
  validateMachineName(type, "type");
  validateUuid(id);
  const targetLang = assertDraftLangcode(langcode);

  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", entityType, type);

  if (entityType !== "node") {
    throw new Error("Governed translation create is implemented for nodes. Other entity types are not addressed by the draft-translation contract.");
  }

  const backend = await resolveBackend(site);
  const existing = await backend.getEntity({ entityType, bundle: type, id });
  if (!existing) {
    throw new Error("The entity was not found.");
  }
  const liveVid = entityRevisionId(existing);
  const workingCopy = await loadWorkingCopy(backend, { entityType, bundle: type, id });
  const workingVid = entityRevisionId(workingCopy);
  const sameWorking = workingVid !== null && liveVid !== null && String(workingVid) === String(liveVid);
  const draftRevision = {
    liveVid,
    workingVid: workingCopy && !sameWorking ? workingVid : undefined,
  };

  const safeAttributes = { ...attributes };
  delete safeAttributes.langcode;
  if (safeAttributes.status === undefined && safeAttributes.moderation_state === undefined) {
    safeAttributes.moderation_state = "draft";
  }
  const drafted = await applySafeDraftDefault({
    backend, entityType, bundle: type, id, attributes: safeAttributes, existingEntity: existing,
  });
  assertPublishAllowed(sec, drafted);

  if (dryRun) {
    await createTranslationDraft(backend, {
      entityType, bundle: type, id, langcode: targetLang, attributes: drafted, draftRevision,
    }, true);
    return {
      dryRun: true, operation: "create_translation", entityType, bundle: type, id,
      langcode: targetLang, attributes: drafted,
    };
  }

  const created = await createTranslationDraft(backend, {
    entityType, bundle: type, id, langcode: targetLang, attributes: drafted, draftRevision,
  });
  return redactCanonicalEntity(created, sec, entityType);
}

export const definitions = [
  {
    name: "drupal_list_translations",
    description:
      "List live and working translation langcodes for a Drupal node. Uses Sentinel's " +
      "translation inventory when available (live default revision vs unpublished working " +
      "draft). Core JSON:API alone serves one language and cannot prove others are absent. " +
      "Defaults to node.",
    inputSchema: {
      type: "object", required: ["type", "id"],
      properties: {
        site:       { type: "string", description: "Named site (omit for default)" },
        entityType: { type: "string", description: "Entity type machine name. Default: 'node'." },
        type:       { type: "string", description: "Bundle machine name, e.g. 'basic_page'" },
        id:         { type: "string", description: "Entity UUID" },
      },
    },
  },
  {
    name: "drupal_create_translation",
    description:
      "Create a translation as an unpublished non-default draft revision (governed write). " +
      "Adds the target language beside the default language; it does not PATCH langcode on " +
      "the canonical entity. English live title, body, status, alias, and default revision " +
      "stay unchanged. An existing translation is a conflict, not an overwrite. Continue the " +
      "draft with drupal_update_node and langcode. Requires Sentinel's draft-translation " +
      "endpoint and a translatable bundle. Paragraph field values are not translated on this " +
      "path. Defaults to node. Publication stays denied for content-tier callers.",
    inputSchema: {
      type: "object", required: ["type", "id", "langcode"],
      properties: {
        site:       { type: "string" },
        entityType: { type: "string", description: "Entity type machine name. Default: 'node'." },
        type:       { type: "string", description: "Bundle machine name, e.g. 'basic_page'" },
        id:         { type: "string", description: "Entity UUID" },
        langcode:   { type: "string", description: "Target language code, e.g. 'es', 'de', 'pt-br'" },
        attributes: { type: "object", description: "Translated field values keyed by Drupal machine name" },
        dryRun:     { type: "boolean", description: "Validate without saving" },
      },
    },
  },
];

export const handlers = {
  drupal_list_translations:  listTranslations,
  drupal_create_translation: createTranslation,
};
