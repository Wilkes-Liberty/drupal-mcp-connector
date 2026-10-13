/**
 * Deny-by-default tool scope table (DEV-862).
 *
 * Every built-in tool that the connector registers must have an explicit
 * non-empty `requiredScopes` entry. On a network listener a name that is
 * missing from this table, or listed with `requiredScopes: []`, is not
 * advertised and not callable. Hosted/network startup refuses to listen
 * when the registry and this table disagree. Stdio still treats the local
 * operator as unrestricted; this module is the fail-closed network gate.
 *
 * The historical default (`mcp_read` for an unknown name, empty
 * `auth.requiredScopes`) is what this table replaces. Do not reintroduce a
 * catch-all.
 */

/** Named refusal when a tool has no table row. */
export const MISSING_SCOPE_ENTRY_REASON = "Tool is not in the scope table";

/** Named refusal when a table row lists no scopes (treated as unrestricted in v3.2.x). */
export const EMPTY_REQUIRED_SCOPES_REASON = "Tool has empty requiredScopes";

/**
 * Hosted/network startup reason when any registered tool is missing or empty.
 * @param {string} detail
 * @returns {string}
 */
export function hostedScopeTableFatal(detail) {
  return `Hosted/network profile refuses an incomplete tool scope table: ${detail}`;
}

/**
 * @param {string} scope
 * @param {readonly string[]} names
 * @returns {Array<[string, {requiredScopes: readonly string[]}]>}
 */
function scoped(scope, names) {
  return names.map((name) => [name, Object.freeze({ requiredScopes: Object.freeze([scope]) })]);
}

/**
 * Explicit per-tool inbound scopes. A name that is not a key here is
 * unscoped. Do not derive rows from `inferOperation` at load time — that
 * would restore the fail-open default for a newly registered tool.
 */
export const TOOL_SCOPE_TABLE = Object.freeze(Object.fromEntries([
  ...scoped("mcp_admin", [
    "drupal_drush_sql_query",
  ]),
  ...scoped("mcp_config", [
    "drupal_config_set",
    "drupal_drush_config_import",
  ]),
  ...scoped("mcp_config_read", [
    "drupal_config_get",
    "drupal_config_list",
    "drupal_drush_config_export",
    "drupal_drush_config_status",
  ]),
  ...scoped("mcp_write", [
    "drupal_block_user",
    "drupal_bulk_create",
    "drupal_bulk_update",
    "drupal_create_block",
    "drupal_create_media",
    "drupal_create_menu_link",
    "drupal_create_node",
    "drupal_create_paragraph",
    "drupal_create_redirect",
    "drupal_create_taxonomy_term",
    "drupal_create_translation",
    "drupal_create_user",
    "drupal_delete_media",
    "drupal_delete_node",
    "drupal_delete_taxonomy_term",
    "drupal_draft_nested_components",
    "drupal_drush_cache_rebuild",
    "drupal_drush_cron",
    "drupal_drush_module_disable",
    "drupal_drush_module_enable",
    "drupal_drush_updatedb",
    "drupal_drush_user_create",
    "drupal_entity_create",
    "drupal_entity_delete",
    "drupal_entity_update",
    "drupal_revert_revision",
    "drupal_schedule_publish",
    "drupal_set_moderation_state",
    "drupal_update_media",
    "drupal_update_menu_link",
    "drupal_update_node",
    "drupal_update_paragraph",
    "drupal_update_redirect",
    "drupal_update_taxonomy_term",
    "drupal_update_user",
    "drupal_upload_file",
    "drupal_upload_file_and_create_media",
  ]),
  ...scoped("mcp_read", [
    "drupal_audit_config_best_practices",
    "drupal_audit_site_health",
    "drupal_codegen_diff",
    "drupal_codegen_generate",
    "drupal_codegen_inspect",
    "drupal_content_by_moderation_state",
    "drupal_describe_fields",
    "drupal_drush_module_list",
    "drupal_drush_security_updates",
    "drupal_drush_status",
    "drupal_drush_user_list",
    "drupal_drush_watchdog",
    "drupal_entity_get",
    "drupal_entity_list",
    "drupal_find_orphaned_media",
    "drupal_get_entity_schema",
    "drupal_get_media",
    "drupal_get_node",
    "drupal_get_paragraph",
    "drupal_get_revision",
    "drupal_get_taxonomy_term",
    "drupal_get_taxonomy_terms",
    "drupal_get_user",
    "drupal_get_user_by_name",
    "drupal_governance_status",
    "drupal_graphql",
    "drupal_graphql_introspect",
    "drupal_list_blocks",
    "drupal_list_content_types",
    "drupal_list_entity_types",
    "drupal_list_media",
    "drupal_list_media_types",
    "drupal_list_menu_links",
    "drupal_list_moderation_states",
    "drupal_list_nodes",
    "drupal_list_revisions",
    "drupal_list_roles",
    "drupal_list_sites",
    "drupal_list_translations",
    "drupal_list_users",
    "drupal_list_vocabularies",
    "drupal_mcp_whoami",
    "drupal_report_404_log",
    "drupal_report_accessibility_audit",
    "drupal_report_alias_coverage",
    "drupal_report_broken_embeds",
    "drupal_report_broken_links",
    "drupal_report_cache_config",
    "drupal_report_config_drift",
    "drupal_report_content_by_author",
    "drupal_report_content_summary",
    "drupal_report_duplicate_content",
    "drupal_report_field_completeness",
    "drupal_report_menu_integrity",
    "drupal_report_missing_field",
    "drupal_report_module_audit",
    "drupal_report_orphan_pages",
    "drupal_report_orphaned_references",
    "drupal_report_permission_audit",
    "drupal_report_pii_exposure",
    "drupal_report_readability",
    "drupal_report_recently_published",
    "drupal_report_redirect_health",
    "drupal_report_revision_hotspots",
    "drupal_report_scheduled_content",
    "drupal_report_seo_audit",
    "drupal_report_seo_meta_coverage",
    "drupal_report_stale_content",
    "drupal_report_status_report",
    "drupal_report_taxonomy_usage",
    "drupal_report_text_format_audit",
    "drupal_report_translation_coverage",
    "drupal_report_unpublished",
    "drupal_report_user_activity",
    "drupal_report_workflow_bottlenecks",
    "drupal_resolve_reference",
    "drupal_search",
    "drupal_search_content",
    "drupal_security_info",
    "drupal_site_info",
  ]),
]));

/**
 * @param {string} toolName
 * @returns {{requiredScopes: readonly string[]}|undefined}
 */
export function toolScopeEntry(toolName) {
  // eslint-disable-next-line security/detect-object-injection -- toolName is an MCP tool name; the table is a frozen closed map
  return TOOL_SCOPE_TABLE[toolName];
}

/**
 * Explicit required scopes for a built-in tool, or `null` when the name
 * has no table row. An empty array is a listed-but-unrestricted row and is
 * refused on the network path.
 *
 * @param {string} toolName
 * @returns {readonly string[]|null}
 */
export function requiredScopesForTool(toolName) {
  const entry = toolScopeEntry(toolName);
  if (!entry) return null;
  return Array.isArray(entry.requiredScopes) ? entry.requiredScopes : [];
}

/**
 * Fail-closed reason for a network listener, or `null` when the tool may
 * proceed to the usual scope / entitlement checks.
 *
 * @param {string} toolName
 * @returns {?string}
 */
export function networkToolScopeDenial(toolName) {
  const entry = toolScopeEntry(toolName);
  if (!entry) return `${MISSING_SCOPE_ENTRY_REASON} (${toolName}).`;
  const scopes = Array.isArray(entry.requiredScopes) ? entry.requiredScopes : [];
  if (scopes.length === 0 || scopes.some((scope) => !String(scope).trim())) {
    return `${EMPTY_REQUIRED_SCOPES_REASON} (${toolName}).`;
  }
  return null;
}

/**
 * Hosted/network startup gate. Fatal when any registered tool is missing
 * from the table or has empty `requiredScopes`.
 *
 * @param {Array<{name: string}>} definitions
 * @param {Record<string, {requiredScopes?: readonly string[]}>} [table]
 * @returns {void}
 * @throws {Error} Named reason listing the offending tool names.
 */
export function assertHostedToolScopeTable(definitions, table = TOOL_SCOPE_TABLE) {
  const missing = [];
  const empty = [];
  for (const definition of definitions ?? []) {
    const name = definition?.name;
    if (typeof name !== "string" || !name) continue;
    // eslint-disable-next-line security/detect-object-injection -- name is a registered tool name; table is a closed map
    const entry = table[name];
    if (!entry) {
      missing.push(name);
      continue;
    }
    const scopes = Array.isArray(entry.requiredScopes) ? entry.requiredScopes : [];
    if (scopes.length === 0 || scopes.some((scope) => !String(scope).trim())) {
      empty.push(name);
    }
  }
  const parts = [];
  if (missing.length) {
    parts.push(`${MISSING_SCOPE_ENTRY_REASON}: ${missing.join(", ")}`);
  }
  if (empty.length) {
    parts.push(`${EMPTY_REQUIRED_SCOPES_REASON}: ${empty.join(", ")}`);
  }
  if (parts.length) {
    throw new Error(hostedScopeTableFatal(parts.join("; ")));
  }
}
