---
description: "Check if active config is in sync with the sync directory. Returns out-of-sync items if any."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_drush_config_status
---

Call the `mcp__drupal__drupal_drush_config_status` MCP tool.

Check if active config is in sync with the sync directory. Returns out-of-sync items if any.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
