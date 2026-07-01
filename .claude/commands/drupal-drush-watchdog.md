---
description: "Fetch recent Drupal watchdog/dblog entries. Filter by type or severity level."
argument-hint: "[site] [type] [severity] [limit]"
allowed-tools: mcp__drupal__drupal_drush_watchdog
---

Call the `mcp__drupal__drupal_drush_watchdog` MCP tool.

Fetch recent Drupal watchdog/dblog entries. Filter by type or severity level.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string)
- `severity` (string)
- `limit` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
