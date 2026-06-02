/**
 * Shared helpers for the reporting tools — backend-neutral.
 */

const BASE_KEYS = new Set(["id", "title", "status", "langcode", "created", "changed", "url"]);

/**
 * Collect up to maxItems canonical entities by paging listEntities via offset.
 * chunk is the per-request page size (default 50, matching JSON:API's page cap).
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

/** A report that cannot run on the resolved backend — structured, not thrown. */
export function gatedReport(report, backend, reason) {
  return { unavailable: true, report, backend, reason };
}

/** Read a value from a canonical entity by trying base props then field-name candidates. */
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

/** Whole days between an ISO/string date and now. */
export function daysSince(dateValue) {
  if (!dateValue) return null;
  return Math.floor((Date.now() - new Date(dateValue).getTime()) / 86400000);
}
