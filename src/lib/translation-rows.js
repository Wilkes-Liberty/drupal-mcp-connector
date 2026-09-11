/**
 * Normalize Sentinel translation-inventory rows for tools and reports.
 *
 * Extra keys (`outdated`, `source`) are passed through only when present so
 * older Sentinel versions do not grow invented `outdated: false`.
 */

/**
 * @param {object} row Inventory translation row.
 * @returns {object}
 */
export function mapTranslationRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = {
    langcode: row.langcode,
    default: Boolean(row.default),
    status: row.status,
    title: row.title,
    moderation_state: row.moderation_state ?? null,
  };
  if (Object.prototype.hasOwnProperty.call(row, "outdated")) {
    out.outdated = Boolean(row.outdated);
  }
  if (typeof row.source === "string" && row.source) {
    out.source = row.source;
  }
  return out;
}

/**
 * Editorial current row per langcode: working copy wins over live.
 * @param {?object} inventory
 * @returns {object[]}
 */
export function inventoryTranslationRows(inventory) {
  const byLang = new Map();
  for (const row of inventory?.live?.translations ?? []) {
    if (row?.langcode) byLang.set(row.langcode, { ...mapTranslationRow(row), revision: "live" });
  }
  for (const row of inventory?.working?.translations ?? []) {
    if (row?.langcode) byLang.set(row.langcode, { ...mapTranslationRow(row), revision: "working" });
  }
  return [...byLang.values()];
}

/**
 * Whether inventory has a row matching langcode and/or moderation state.
 * @param {?object} inventory
 * @param {{langcode?: string, state?: string}} match
 * @returns {?object}
 */
export function inventoryRowMatching(inventory, { langcode, state } = {}) {
  const wantedState = state === undefined || state === null ? null : String(state).toLowerCase();
  return inventoryTranslationRows(inventory).find((row) => {
    if (langcode && row.langcode !== langcode) return false;
    if (wantedState && String(row.moderation_state || "").toLowerCase() !== wantedState) return false;
    return true;
  }) ?? null;
}
