/**
 * Compatibility facade for the Sentinel HTTP client.
 * New call sites should import from `./sentinel-draft.js`.
 */

export {
  assertDraftLangcode,
  assertInventoryDraftLanguage,
  createTranslationDraft,
  isMissingDraftEndpoint,
  isMissingTranslationEndpoint,
  readDraftTranslation,
  readNodeDraftInventory,
  readTranslationInventory,
  resolveNodeTranslationPair,
  rewriteTranslationWorkingRevisionError,
  supportsSentinelDraft,
  writeDraft,
} from "./sentinel-draft.js";
