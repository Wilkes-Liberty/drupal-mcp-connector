/**
 * Shared helpers for the reporting tools — backend-neutral.
 */

/** Canonical base property names (read directly off the entity, not from `fields`). */
const BASE_KEYS = new Set(["id", "title", "status", "langcode", "created", "changed", "url"]);

/** Whole-day length in milliseconds, used by daysSince(). */
const MS_PER_DAY = 86400000;

/**
 * Collect up to maxItems canonical entities by paging listEntities via offset.
 * Stops early once a short page or a falsy hasNext signals the end of results.
 * @param {{listEntities: Function}} backend Resolved backend with listEntities().
 * @param {object} descriptor Query descriptor passed through to listEntities.
 * @param {number} [maxItems] Hard cap on total entities returned.
 * @param {number} [chunk] Per-request page size (default 50, matching JSON:API's cap).
 * @returns {Promise<object[]>} Up to maxItems canonical entities.
 */
export async function collectEntities(backend, descriptor, maxItems = 100, chunk = 50) {
  const out = [];
  let offset = 0;
  for (;;) {
    const limit = Math.min(chunk, maxItems - out.length);
    if (limit <= 0) break;
    const res = await backend.listEntities({ ...descriptor, page: { limit, offset } });
    const batch = res.entities ?? [];
    out.push(...batch);
    if (batch.length < limit || !res.page?.hasNext) break;
    offset += batch.length;
  }
  return out.slice(0, maxItems);
}

/**
 * Build a structured "report unavailable" result (returned, not thrown, so a
 * caller can report a gated feature without aborting a batch of reports).
 * @param {string} report Report identifier.
 * @param {string} backend Backend the report was attempted against.
 * @param {string} reason Why the report cannot run here.
 * @returns {{unavailable: true, report: string, backend: string, reason: string}}
 */
export function gatedReport(report, backend, reason) {
  return { unavailable: true, report, backend, reason };
}

/**
 * Read a value from a canonical entity by trying base props then `fields`,
 * returning the first candidate name that resolves to a defined value.
 * @param {object} entity Canonical entity.
 * @param {string[]} candidates Field/prop names to try, in priority order.
 * @returns {*} The first matching value, or undefined if none match.
 */
export function fieldValue(entity, candidates) {
  const base = new Map(Object.entries(entity));
  const fields = entity.fields ? new Map(Object.entries(entity.fields)) : new Map();
  for (const name of candidates) {
    if (BASE_KEYS.has(name)) {
      if (base.has(name) && base.get(name) !== undefined) return base.get(name);
      continue;
    }
    if (fields.has(name)) return fields.get(name);
  }
  return undefined;
}

/**
 * Whole days elapsed between a date and now.
 * @param {?(string|number|Date)} dateValue A date parseable by `new Date()`.
 * @returns {?number} Whole days since the date, or null when no date is given.
 */
export function daysSince(dateValue) {
  if (!dateValue) return null;
  return Math.floor((Date.now() - new Date(dateValue).getTime()) / MS_PER_DAY);
}
