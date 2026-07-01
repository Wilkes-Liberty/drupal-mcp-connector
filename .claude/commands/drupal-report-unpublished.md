---
description: "List unpublished/draft content of a given type. Returns a finding list with titles, last-changed dates, and paths. Useful for surfacing forgotten drafts."
argument-hint: "[site] [type] [limit]"
allowed-tools: mcp__drupal__drupal_report_unpublished
---

Call the `mcp__drupal__drupal_report_unpublished` MCP tool.

List unpublished/draft content of a given type. Returns a finding list with titles, last-changed dates, and paths. Useful for surfacing forgotten drafts.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type machine name (default: article)
- `limit` (number): Max unpublished nodes to return

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
