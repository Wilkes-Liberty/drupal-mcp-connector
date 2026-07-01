---
description: "List the most recently published content of a given type."
argument-hint: "[site] [type] [limit]"
allowed-tools: mcp__drupal__drupal_report_recently_published
---

Call the `mcp__drupal__drupal_report_recently_published` MCP tool.

List the most recently published content of a given type.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `limit` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
