---
description: "List modules with known security advisories via `drush pm:security`."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_drush_security_updates
---

Call the `mcp__drupal__drupal_drush_security_updates` MCP tool.

List modules with known security advisories via `drush pm:security`.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
