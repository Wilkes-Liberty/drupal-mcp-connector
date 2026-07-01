---
description: "List all content types defined on this Drupal site with their machine names and descriptions."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_list_content_types
---

Call the `mcp__drupal__drupal_list_content_types` MCP tool.

List all content types defined on this Drupal site with their machine names and descriptions.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
