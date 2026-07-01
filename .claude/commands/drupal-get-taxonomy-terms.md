---
description: "List all terms in a taxonomy vocabulary, sorted by name."
argument-hint: "<vocabulary> [site] [limit] [offset]"
allowed-tools: mcp__drupal__drupal_get_taxonomy_terms
---

Call the `mcp__drupal__drupal_get_taxonomy_terms` MCP tool.

List all terms in a taxonomy vocabulary, sorted by name.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `vocabulary` (string): Vocabulary machine name, e.g. 'tags'

**Optional:**
- `site` (string): omit for the default site
- `limit` (number)
- `offset` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
