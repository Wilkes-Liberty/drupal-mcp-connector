---
description: "Count nodes per author for a given content type. Returns author UUIDs and counts sorted by most prolific."
argument-hint: "[site] [type] [limit]"
allowed-tools: mcp__drupal__drupal_report_content_by_author
---

Call the `mcp__drupal__drupal_report_content_by_author` MCP tool.

Count nodes per author for a given content type. Returns author UUIDs and counts sorted by most prolific.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `limit` (number): Max nodes to scan

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
