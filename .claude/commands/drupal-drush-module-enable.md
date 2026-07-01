---
description: "Enable a Drupal module. Module name validated as machine name. Requires write access."
argument-hint: "<moduleName> [site]"
allowed-tools: mcp__drupal__drupal_drush_module_enable
---

Call the `mcp__drupal__drupal_drush_module_enable` MCP tool.

Enable a Drupal module. Module name validated as machine name. Requires write access.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `moduleName` (string)

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
