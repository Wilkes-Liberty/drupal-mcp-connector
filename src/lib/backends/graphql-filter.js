/**
 * Client-side filter and sort over canonical entities.
 *
 * Single responsibility: apply filter predicates and sort orders in JS for the
 * GraphQL backend, which cannot filter (and can only sort by a fixed enum of
 * keys) server-side. This runs over the bounded set of records the backend
 * already paged in (up to its client-record cap), which is why the results it
 * feeds are flagged `approximate`/`truncated` upstream.
 */

const BASE_GETTERS = new Map([
  ["id",      (e) => e.id],
  ["title",   (e) => e.title],
  ["status",  (e) => e.status],
  ["langcode",(e) => e.langcode],
  ["created", (e) => e.created],
  ["changed", (e) => e.changed],
  ["url",     (e) => e.url],
]);

/**
 * Build a value accessor for one entity. The entity's custom fields are copied
 * into a Map ONCE here, so repeated lookups across many filters/sort keys do not
 * re-build it per access (this runs over up to ~1000 records in the GraphQL path).
 * The Map(Object.entries()) lookup also keeps field access object-injection-safe.
 * @param {import("../canonical.js").CanonicalEntity} entity
 * @returns {(field: string) => *} Resolver returning the value for a field name.
 */
function accessorFor(entity) {
  const custom = entity.fields ? new Map(Object.entries(entity.fields)) : new Map();
  return (field) => {
    const base = BASE_GETTERS.get(field);
    return base ? base(entity) : custom.get(field);
  };
}

/**
 * Evaluate a single filter condition against an entity's value accessor.
 * @param {(field: string) => *} get Value accessor from {@link accessorFor}.
 * @param {{field: string, op?: string, value: *}} cond Filter condition.
 * @returns {boolean} True when the condition holds (unknown ops return false).
 */
function matches(get, { field, op = "eq", value }) {
  const v = get(field);
  switch (op) {
    case "eq": return v === value;
    case "neq": return v !== value;
    case "gt": return v > value;
    case "gte": return v >= value;
    case "lt": return v < value;
    case "lte": return v <= value;
    case "contains": return String(v ?? "").toLowerCase().includes(String(value).toLowerCase());
    case "in": return Array.isArray(value) && value.includes(v);
    case "isNull": return v === null || v === undefined;
    default: return false;
  }
}

/**
 * Filter entities by an AND-combined list of conditions.
 * @param {import("../canonical.js").CanonicalEntity[]} entities
 * @param {Array<{field: string, op?: string, value: *}>} [filters]
 * @returns {import("../canonical.js").CanonicalEntity[]} New filtered array
 *   (or the input array unchanged when there are no filters).
 */
export function applyClientFilters(entities, filters = []) {
  if (!filters.length) return entities;
  return entities.filter((e) => {
    const get = accessorFor(e);
    return filters.every((f) => matches(get, f));
  });
}

/**
 * Sort entities by an ordered list of sort keys (later keys break ties).
 * @param {import("../canonical.js").CanonicalEntity[]} entities
 * @param {Array<{field: string, dir?: "asc"|"desc"}>} [sort]
 * @returns {import("../canonical.js").CanonicalEntity[]} New sorted array
 *   (or the input array unchanged when there is no sort).
 */
export function applyClientSort(entities, sort = []) {
  if (!sort.length) return entities;
  // Build one accessor per entity up front (keyed by the entity object) so the
  // comparator never re-builds the per-entity fields Map.
  const accessors = new Map(entities.map((e) => [e, accessorFor(e)]));
  const sorted = [...entities];
  sorted.sort((a, b) => {
    const ga = accessors.get(a);
    const gb = accessors.get(b);
    for (const { field, dir = "asc" } of sort) {
      const av = ga(field);
      const bv = gb(field);
      if (av < bv) return dir === "desc" ? 1 : -1;
      if (av > bv) return dir === "desc" ? -1 : 1;
    }
    return 0;
  });
  return sorted;
}
