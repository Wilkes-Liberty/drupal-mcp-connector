---
description: "Report content with Scheduler publish/unpublish dates set, split into pending (future) and overdue (past, action not run). Gated when scheduler fields aren't exposed."
argument-hint: "[site] [type] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_scheduled_content
---

Call the `mcp__drupal__drupal_report_scheduled_content` MCP tool.

Report content with Scheduler publish/unpublish dates set, split into pending (future) and overdue (past, action not run). Gated when scheduler fields aren't exposed.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type (default: article)
- `sampleSize` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
