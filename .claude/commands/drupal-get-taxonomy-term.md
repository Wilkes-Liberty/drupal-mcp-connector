---
description: "Fetch a single taxonomy term by UUID."
argument-hint: "<vocabulary> <id> [site]"
allowed-tools: mcp__drupal__drupal_get_taxonomy_term
---

Call the `mcp__drupal__drupal_get_taxonomy_term` MCP tool.

Fetch a single taxonomy term by UUID.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `vocabulary` (string)
- `id` (string): Term UUID

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
