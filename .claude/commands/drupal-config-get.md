---
description: "Read a single Drupal configuration object by name (e.g. \"system.site\") via the governed server-side config tool. Requires config read access."
argument-hint: "[site] <name>"
allowed-tools: mcp__drupal__drupal_config_get
---

Call the `mcp__drupal__drupal_config_get` MCP tool.

Read a single Drupal configuration object by name (e.g. "system.site") via the governed server-side config tool. Requires config read access.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `name` (string)

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
