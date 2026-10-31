---
section: Changed
---
Collapse leftover sql/config/entity-write name lists in `requiredScopeForTool` onto `TOOL_SCOPE_TABLE`. Live catalog behavior is unchanged. Untabled stdio names fail closed by family (`drupal_drush_sql_*` needs `mcp_admin`; `drupal_config_*` / `drupal_drush_config_*` need `mcp_config`) and write-like names still need `mcp_write`. A missing registered row is also caught by `tests/lib/tool-scopes.test.js`.
