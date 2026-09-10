/**
 * URL-alias helpers shared by node writes and the JSON:API path reader.
 *
 * Path aliases are not revisioned. The node's `path` field is a computed
 * view of `path_alias` rows; unpublished / forward revisions often omit
 * `pid` even when a row exists. Round-tripping that pid (and verifying
 * after save) is how title-only edits keep the existing alias (#274).
 */

/** JSON:API entity type + bundle for a path alias row. */
export const PATH_ALIAS_ENTITY_TYPE = "path_alias";

/**
 * Normalize a URL-alias path for storage/comparison: trim, ensure a single
 * leading slash, drop a trailing slash (except root).
 * @param {*} value A raw alias.
 * @returns {?string} The normalized alias, or null when empty.
 */
export function normalizeAlias(value) {
  if (value === undefined || value === null) return null;
  let s = String(value).trim();
  if (!s) return null;
  if (!s.startsWith("/")) s = `/${s}`;
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}

/**
 * Whether a value is a positive integer node id suitable for `/node/{nid}`.
 * @param {*} value Raw drupal internal id.
 * @returns {boolean}
 */
export function isPositiveNid(value) {
  if (value === undefined || value === null || value === "") return false;
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}
