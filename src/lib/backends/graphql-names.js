/**
 * Pure helpers mapping graphql_compose type names to Drupal entityType/bundle.
 *
 * graphql_compose names a type as <Prefix><PascalBundle>, where Prefix encodes
 * the entity type (Node, Media, Term=taxonomy_term, Paragraph, BlockContent,
 * Menu, User). Single-type entities (User, Menu) have no bundle suffix.
 */

// Longest prefixes first so "BlockContent" wins over a hypothetical "Block".
const PREFIXES = [
  ["BlockContent", "block_content"],
  ["Paragraph", "paragraph"],
  ["Media", "media"],
  ["Term", "taxonomy_term"],
  ["Menu", "menu"],
  ["Node", "node"],
  ["User", "user"],
];

export function pascalToSnake(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function snakeToPascal(s) {
  return s.split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

/**
 * @param {string} typeName e.g. "NodeArticle"
 * @returns {{entityType:string, bundle:string}|null}
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
