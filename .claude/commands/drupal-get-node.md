---
description: "Fetch a single Drupal content node by UUID and content type. Returns title, body, status, path alias, and all attributes."
argument-hint: "<type> <id> [site]"
allowed-tools: mcp__drupal__drupal_get_node
---

Call the `mcp__drupal__drupal_get_node` MCP tool.

Fetch a single Drupal content node by UUID and content type. Returns title, body, status, path alias, and all attributes.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name, e.g. 'article'
- `id` (string): Node UUID

**Optional:**
- `site` (string): Named site (omit for default)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
