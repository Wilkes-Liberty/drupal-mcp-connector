---
description: "Import configuration from the sync directory into the database. Requires write access. Confirm with user before running on production."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_drush_config_import
---

Call the `mcp__drupal__drupal_drush_config_import` MCP tool.

Import configuration from the sync directory into the database. Requires write access. Confirm with user before running on production.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
