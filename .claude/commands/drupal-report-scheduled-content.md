---
description: "Report content with Scheduler publish/unpublish dates set, split into pending (future) and overdue (past, action not run). Gated when scheduler fields aren't exposed."
argument-hint: "[site] [type] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_scheduled_content
---

Call the `mcp__drupal__drupal_report_scheduled_content` MCP tool.

Report content with Scheduler publish/unpublish dates set, split into pending (future) and overdue (past, action not run). Gated when scheduler fields aren't exposed.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `sampleSize` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
