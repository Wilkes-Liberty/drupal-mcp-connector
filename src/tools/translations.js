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
 * Paragraph field-value translation uses the same surface with
 * entityType "paragraph" and the pinned paragraph revision. Image alt is a
 * node relationship (`meta.alt`) with the shared file target unchanged.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import {
  resolveSecurityConfig, assertReadAllowed, assertWriteAllowed, assertPublishAllowed,
  redactCanonicalEntity,
} from "../lib/security.js";
import { validateUuid, validateMachineName } from "../lib/validate.js";
import { applySafeDraftDefault } from "../lib/moderation-default.js";
import { omitLiveComputedMetatag } from "../lib/entity-response.js";
import { entityRevisionId } from "../lib/write-revision.js";
import { paragraphRevisionId } from "../lib/err-relationships.js";
import {
  assertDraftLangcode,
  createTranslationDraft,
  readTranslationInventory,
  resolveNodeTranslationPair,
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
  if ((entityType === "node" || entityType === "paragraph") && typeof backend.rawQuery === "function") {
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
  site: siteName, entityType = "node", type, id, langcode, attributes = {},
  relationships, revisionId, dryRun = false,
}) {
  validateMachineName(entityType, "entityType");
  validateMachineName(type, "type");
  validateUuid(id);
  const targetLang = assertDraftLangcode(langcode);

  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertWriteAllowed(sec, "update", entityType, type);

  if (entityType !== "node" && entityType !== "paragraph") {
    throw new Error("Governed translation create is implemented for nodes and paragraphs.");
  }

  const backend = await resolveBackend(site);
  const existing = await backend.getEntity({ entityType, bundle: type, id });
  if (!existing) {
    throw new Error("The entity was not found.");
  }

  let draftRevision;
  let drafted = { ...attributes };
  delete drafted.langcode;
  if (entityType === "paragraph") {
    const pinned = revisionId ?? paragraphRevisionId(existing);
    if (pinned === null || pinned === undefined || pinned === "") {
      throw new Error("Paragraph translation create requires a paragraph revision ID (the host pin).");
    }
    draftRevision = { revisionId: pinned };
    assertPublishAllowed(sec, drafted);
  } else {
    draftRevision = await resolveNodeTranslationPair(backend, {
      entityType, bundle: type, id, existing,
    });
    if (drafted.status === undefined && drafted.moderation_state === undefined) {
      drafted.moderation_state = "draft";
    }
    drafted = await applySafeDraftDefault({
      backend, entityType, bundle: type, id, attributes: drafted, existingEntity: existing,
    });
    assertPublishAllowed(sec, drafted);
  }

  if (dryRun) {
    await createTranslationDraft(backend, {
      entityType, bundle: type, id, langcode: targetLang, attributes: drafted, relationships, draftRevision,
    }, true);
    return {
      dryRun: true, operation: "create_translation", entityType, bundle: type, id,
      langcode: targetLang, attributes: drafted, ...(relationships ? { relationships } : {}),
    };
  }

  const created = await createTranslationDraft(backend, {
    entityType, bundle: type, id, langcode: targetLang, attributes: drafted, relationships, draftRevision,
  });
  const redacted = omitLiveComputedMetatag(redactCanonicalEntity(created, sec, entityType));
  if (entityType !== "node") return redacted;
  const workingVid = entityRevisionId(created) ?? draftRevision.workingVid;
  const liveVid = draftRevision.liveVid;
  if (liveVid === undefined || liveVid === null) {
    if (workingVid === undefined || workingVid === null) return redacted;
  }
  return {
    ...redacted,
    _revisions: {
      ...(liveVid !== undefined && liveVid !== null ? { live: liveVid } : {}),
      ...(workingVid !== undefined && workingVid !== null ? { working: workingVid } : {}),
    },
  };
}

export const definitions = [
  {
    name: "drupal_list_translations",
    description:
      "List live and working translation langcodes for a Drupal node or paragraph. Uses Sentinel's " +
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
      "Create a translation as an unpublished non-default draft (governed write). " +
      "Adds the target language beside the default language; it does not PATCH langcode on " +
      "the canonical entity. When an English working draft already exists, both live and " +
      "working revision IDs are sent (If-Match) so Sentinel will add the language on that " +
      "draft (#282). English live title, body, status, alias, default revision, and " +
      "paragraph ERR pins stay unchanged. An existing translation is a conflict, not an overwrite. " +
      "The response includes `_revisions.live` / `_revisions.working` when known. " +
      "Computed `metatag` is omitted on the draft body because JSON:API resolves it from the live default (#283); use field_metatags. " +
      "Continue a node draft with drupal_update_node and langcode; continue a paragraph with " +
      "drupal_update_paragraph and langcode. Image alt is a relationship (same file UUID, " +
      "meta.alt). For paragraphs pass revisionId as the host pin. Requires Sentinel's " +
      "draft-translation endpoint. Publication stays denied for content-tier callers.",
    inputSchema: {
      type: "object", required: ["type", "id", "langcode"],
      properties: {
        site:          { type: "string" },
        entityType:    { type: "string", description: "Entity type machine name. Default: 'node'. Use 'paragraph' for paragraph field values." },
        type:          { type: "string", description: "Bundle machine name, e.g. 'basic_page' or 'p_hero'" },
        id:            { type: "string", description: "Entity UUID" },
        langcode:      { type: "string", description: "Target language code, e.g. 'es', 'de', 'pt-br'" },
        attributes:    { type: "object", description: "Translated field values keyed by Drupal machine name" },
        relationships: { type: "object", description: "JSON:API relationships. Use for image alt (same file UUID, meta.alt)." },
        revisionId:    { type: "string", description: "Paragraph revision id the host already pins. Required for Home-shaped non-default pins." },
        dryRun:        { type: "boolean", description: "Validate without saving" },
      },
    },
  },
];

export const handlers = {
  drupal_list_translations:  listTranslations,
  drupal_create_translation: createTranslation,
};
