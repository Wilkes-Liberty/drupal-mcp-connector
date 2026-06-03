/**
 * Pure helpers mapping graphql_compose type names to Drupal entityType/bundle.
 *
 * graphql_compose names a type as <Prefix><PascalBundle>, where Prefix encodes
 * the entity type (Node, Media, Term=taxonomy_term, Paragraph, BlockContent,
 * Menu, User). Single-type entities (User, Menu) have no bundle suffix.
 */

// Type-name prefix -> Drupal entity type. Order matters: longer/more-specific
// prefixes are listed first so a type like "BlockContent..." matches
// "BlockContent" before a hypothetical shorter "Block" prefix.
const PREFIXES = [
  ["BlockContent", "block_content"],
  ["Paragraph", "paragraph"],
  ["Media", "media"],
  ["Term", "taxonomy_term"],
  ["Menu", "menu"],
  ["Node", "node"],
  ["User", "user"],
];

/**
 * Convert a PascalCase fragment to snake_case (the Drupal bundle convention).
 * @param {string} s e.g. "BasicPage".
 * @returns {string} e.g. "basic_page".
 */
export function pascalToSnake(s) {
  // Two passes: lower/digit->Upper boundaries, then acronym->Word boundaries,
  // so both "fooBar" and "URLAlias" split correctly before lowercasing.
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Convert a snake_case machine name to PascalCase.
 * @param {string} s e.g. "basic_page".
 * @returns {string} e.g. "BasicPage".
 */
export function snakeToPascal(s) {
  return s.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

/**
 * Map a graphql_compose type name to its Drupal entityType/bundle.
 * @param {string} typeName e.g. "NodeArticle".
 * @returns {{entityType: string, bundle: string}|null} Pair, or null when the
 *   name matches no known prefix.
 */
export function graphqlTypeToEntity(typeName) {
  for (const [prefix, entityType] of PREFIXES) {
    if (typeName === prefix) {
      // Single-type entity (User, Menu): bundle == entityType.
      return { entityType, bundle: entityType };
    }
    if (typeName.startsWith(prefix)) {
      const rest = typeName.slice(prefix.length);
      return { entityType, bundle: pascalToSnake(rest) };
    }
  }
  return null;
}
