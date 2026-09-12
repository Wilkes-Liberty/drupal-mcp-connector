/** Sentinel discovery for translation-only node revisions (#297). */
import { readTranslationInventory } from "./draft-write.js";

/**
 * Read optional inventory, falling back only when the endpoint is unsupported.
 * Permission, transport and malformed-response failures are not absence.
 * @param {object} backend
 * @param {{entityType: string, bundle: string, id: string}} ref
 * @returns {Promise<object|null>}
 */
export async function readNodeDraftInventory(backend, ref) {
  if ((ref.entityType !== "node" && ref.entityType !== "media")
    || typeof backend.rawQuery !== "function"
    || typeof backend.resourcePath !== "function") return null;
  let inventory;
  try {
    inventory = await readTranslationInventory(backend, ref);
  } catch (error) {
    if (/does not provide Sentinel's governed draft-translation endpoint/.test(error.message)) return null;
    throw error;
  }
  const validVid = (vid) => /^[1-9]\d*$/.test(String(vid ?? "")) && Number.isSafeInteger(Number(vid));
  if (!validVid(inventory.live?.vid)
    || (inventory.working && (!validVid(inventory.working.vid)
      || !Array.isArray(inventory.working.translations)
      || inventory.working.translations.some((row) => !row || typeof row.langcode !== "string"
        || typeof row.status !== "boolean")))) {
    throw new Error("Sentinel returned an invalid revision inventory. Re-read before updating.");
  }
  return inventory;
}

/**
 * Ensure inventory discovery does not turn a published language into a draft.
 * Sentinel still validates the revision pair and language on every request.
 * @param {object} inventory
 * @param {string|undefined} langcode
 */
export function assertInventoryDraftLanguage(inventory, langcode) {
  const rows = inventory.working?.translations ?? [];
  if (!langcode && rows.length !== 1) {
    throw new Error("This working revision contains translations. Pass an explicit langcode for an existing unpublished language; no draft was created.");
  }
  const row = langcode ? rows.find((item) => item.langcode === langcode) : rows[0];
  if (!row || row.status !== false) {
    throw new Error("The requested language is not an existing unpublished working draft. Published languages and other drafts were left unchanged.");
  }
}
