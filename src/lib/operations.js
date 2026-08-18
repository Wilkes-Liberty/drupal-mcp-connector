/**
 * Operation-intent classification for Drupal MCP tools.
 *
 * A tool's operation (read / write / delete / graphql) is inferred from its name
 * prefix rather than trusting per-tool metadata, so a new tool that follows the
 * naming convention is classified automatically. This single definition is shared
 * by the security middleware (src/index.js), the per-tool MCP prompts
 * (src/lib/tool-prompts.js), and the slash-command generator
 * (scripts/generate-commands.js) so authorization gating and the "destructive"
 * warnings surfaced to users can never drift apart.
 */

import { graphqlHasMutation } from "./security.js";

export const WRITE_PREFIXES = ["drupal_create_", "drupal_update_", "drupal_upload_",
  "drupal_block_",  "drupal_drush_cache", "drupal_drush_cron",
  "drupal_drush_config_export", "drupal_drush_config_import",
  "drupal_drush_updatedb", "drupal_drush_module_enable",
  "drupal_drush_module_disable", "drupal_drush_user_create",
  // v1.0 feature tools that perform writes but don't start with create_/update_:
  "drupal_bulk_", "drupal_revert_", "drupal_schedule_", "drupal_set_",
  // Governed config write (also gated inside the handler by the config-write cap):
  "drupal_config_set"];

export const DESTRUCTIVE_PREFIXES = ["drupal_delete_", "drupal_drush_module_disable"];

/**
 * Classify a tool's operation intent from its name prefix.
 *
 * @param {string} toolName - The MCP tool name being invoked.
 * @returns {"delete"|"write"|"graphql"|"read"} Inferred operation. Destructive
 *   prefixes are checked first so they take precedence over plain write.
 */
export function inferOperation(toolName) {
  if (DESTRUCTIVE_PREFIXES.some((p) => toolName.startsWith(p))) return "delete";
  if (WRITE_PREFIXES.some((p) => toolName.startsWith(p)))       return "write";
  if (toolName === "drupal_graphql")                            return "graphql";
  return "read";
}

// Generic entity tools carry their target type/bundle in ARGS, not the tool name,
// so the security middleware gates them inside their handlers (assertDeleteAllowed /
// assertWriteAllowed with full context) and inferOperation() intentionally leaves
// them classified "read". Write-site gating and the user-facing confirm-first
// WARNING still classify them by name.
const ENTITY_WRITE_TOOLS = new Set([
  "drupal_entity_create",
  "drupal_entity_update",
  "drupal_entity_delete",
]);
const DESTRUCTIVE_ENTITY_TOOLS = new Set(["drupal_entity_delete"]);

/**
 * Whether a tool deletes/destroys data — used to surface a confirm-first warning
 * in prompts and slash commands. Broader than inferOperation()'s "delete": it also
 * covers the generic `drupal_entity_delete` tool, which the prefix-based classifier
 * does not match (see note above).
 *
 * @param {string} toolName - The MCP tool name.
 * @returns {boolean} True for destructive tools.
 */
export function isDestructiveTool(toolName) {
  return inferOperation(toolName) === "delete" || DESTRUCTIVE_ENTITY_TOOLS.has(toolName);
}

/**
 * Whether a tool is a write or delete regardless of how inferOperation classifies it.
 * Covers the generic `drupal_entity_{create,update,delete}` tools that self-gate
 * inside their handlers and are therefore left as "read" by prefix inference.
 *
 * @param {string} toolName - The MCP tool name.
 * @returns {boolean}
 */
export function isWriteLikeTool(toolName) {
  if (ENTITY_WRITE_TOOLS.has(toolName)) return true;
  const op = inferOperation(toolName);
  return op === "write" || op === "delete";
}

/**
 * Whether this invocation mutates the target. GraphQL is a write only when the
 * document contains a mutation; a query is still a read.
 *
 * @param {string} toolName
 * @param {object} [args]
 * @returns {boolean}
 */
export function isWriteLikeCall(toolName, args = {}) {
  if (isWriteLikeTool(toolName)) return true;
  if (inferOperation(toolName) === "graphql" && typeof args.query === "string") {
    return graphqlHasMutation(args.query);
  }
  return false;
}
