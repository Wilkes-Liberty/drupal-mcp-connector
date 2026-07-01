---
description: "Count how many nodes use each term in a vocabulary. Identifies over-used, under-used, and orphaned terms."
argument-hint: "[site] <vocabulary> [contentType] [referenceField] [limit]"
allowed-tools: mcp__drupal__drupal_report_taxonomy_usage
---

Call the `mcp__drupal__drupal_report_taxonomy_usage` MCP tool.

Count how many nodes use each term in a vocabulary. Identifies over-used, under-used, and orphaned terms.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `vocabulary` (string): Vocabulary machine name, e.g. 'tags', 'category'

**Optional:**
- `site` (string): omit for the default site
- `contentType` (string): Content type to count references from (default: article)
- `referenceField` (string): Field referencing the vocabulary (default: field_{vocabulary})
- `limit` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
