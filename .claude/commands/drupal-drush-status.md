---
description: "Get Drupal site status via `drush status` — version, DB, file paths, active config."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_drush_status
---

Call the `mcp__drupal__drupal_drush_status` MCP tool.

Get Drupal site status via `drush status` — version, DB, file paths, active config.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
