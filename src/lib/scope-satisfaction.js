/**
 * Shared OAuth scope-satisfaction rule (DEV-1349).
 *
 * mcp_sentinel is the enforcement point of record. Its
 * `McpToolScopeResolver::resolve()` stamps each tool with one exact scope
 * (`mcp_config_read` for a non-modifying config tool, `mcp_config` for a
 * modifying config tool, `mcp_read` / `mcp_write` for content). The
 * `mcp_server_oauth` subscriber then requires that string on the token.
 * There is no implication table: a write-capable grant does not satisfy a
 * distinct read-only requirement.
 *
 * This connector uses the same rule so a token that would be refused by
 * the module is refused here as well, instead of passing locally and
 * failing on Drupal.
 */

/**
 * Whether a token's granted scopes satisfy a required scope.
 *
 * Exact match only. A grant satisfies a requirement if and only if the
 * required string is present in the grant. Scopes do not nest and do not
 * imply one another: `mcp_config` does not satisfy `mcp_config_read`,
 * `mcp_write` does not satisfy `mcp_read`, and `mcp_admin` does not
 * satisfy any other scope. A missing or empty requirement is unrestricted.
 *
 * @param {readonly string[]|null|undefined} granted Scopes the token holds.
 * @param {string|null|undefined} required Scope the operation demands.
 * @returns {boolean}
 */
export function grantedScopesSatisfy(granted, required) {
  if (required === null || required === undefined || required === "") return true;
  if (!Array.isArray(granted)) return false;
  return granted.includes(required);
}
