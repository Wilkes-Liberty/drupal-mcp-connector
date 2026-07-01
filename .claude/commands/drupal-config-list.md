---
description: "List Drupal configuration object names, optionally filtered by a name prefix, via the governed server-side config tool. Requires config read access."
argument-hint: "[site] [prefix]"
allowed-tools: mcp__drupal__drupal_config_list
---

Call the `mcp__drupal__drupal_config_list` MCP tool.

List Drupal configuration object names, optionally filtered by a name prefix, via the governed server-side config tool. Requires config read access.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `prefix` (string)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
