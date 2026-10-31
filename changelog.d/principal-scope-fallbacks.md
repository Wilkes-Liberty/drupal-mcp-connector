---
section: Security
---
Collapse leftover sql/config/entity-write name lists in `requiredScopeForTool` onto `TOOL_SCOPE_TABLE`. Live catalog rows are unchanged. For a non-local identity on a non-network surface, untabled `drupal_drush_sql_*`, `drupal_config_*`, and `drupal_drush_config_*` names are refused with an explicit denial (never `null`). `assertPrincipalEntitlement` throws that named reason. Other untabled names still use `isWriteLikeTool` / `mcp_read`. Network listeners already refuse every untabled name. Stdio has no governance-denial audit sink; an untabled name with no handler returns Unknown tool before this gate.
