---
description: "Find content that hasn't been updated in N days. Returns a sorted list with titles, status, and days-since-update."
argument-hint: "[site] [type] [days] [status] [limit]"
allowed-tools: mcp__drupal__drupal_report_stale_content
---

Call the `mcp__drupal__drupal_report_stale_content` MCP tool.

Find content that hasn't been updated in N days. Returns a sorted list with titles, status, and days-since-update.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `days` (number): Stale threshold in days
- `status` (boolean (true/false)): Filter by publish status
- `limit` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
