---
description: "Audit role permissions: dangerous grants to the anonymous/authenticated roles and administrative permissions held by non-admin roles. Self-sufficient via the connector's drush bridge (drush role:list)."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_report_permission_audit
---

Call the `mcp__drupal__drupal_report_permission_audit` MCP tool.

Audit role permissions: dangerous grants to the anonymous/authenticated roles and administrative permissions held by non-admin roles. Self-sufficient via the connector's drush bridge (drush role:list).

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
