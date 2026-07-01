---
description: "Uninstall a Drupal module. Irreversible for module-stored data. Confirm with user."
argument-hint: "[site] <moduleName>"
allowed-tools: mcp__drupal__drupal_drush_module_disable
---

Call the `mcp__drupal__drupal_drush_module_disable` MCP tool.

Uninstall a Drupal module. Irreversible for module-stored data. Confirm with user.

> ⚠ **Destructive** — this permanently changes or deletes data. Confirm with the user before calling.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `moduleName` (string)

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
