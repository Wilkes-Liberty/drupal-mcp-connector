---
section: Security
---
Collapse leftover sql/config/entity-write name lists in `requiredScopeForTool` onto `TOOL_SCOPE_TABLE`. Live catalog rows are unchanged. For a non-local identity on a non-network surface, untabled `drupal_drush_sql_*`, `drupal_config_*`, and `drupal_drush_config_*` names are refused with an explicit denial (never `null`, which would mean no scope is needed). Other untabled names still use `isWriteLikeTool` / `mcp_read`, matching master. Network listeners already refuse every untabled name.
