/**
 * Client-side filter + sort over canonical entities, used by the GraphQL
 * backend when the schema cannot filter/sort server-side.
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
 */
function accessorFor(entity) {
  const custom = entity.fields ? new Map(Object.entries(entity.fields)) : new Map();
  return (field) => {
    const base = BASE_GETTERS.get(field);
    return base ? base(entity) : custom.get(field);
  };
}

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

export function applyClientFilters(entities, filters = []) {
  if (!filters.length) return entities;
  return entities.filter((e) => {
    const get = accessorFor(e);
    return filters.every((f) => matches(get, f));
  });
}

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
