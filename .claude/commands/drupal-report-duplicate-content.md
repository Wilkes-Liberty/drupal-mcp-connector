---
description: "Find duplicate / near-duplicate titles within a content type (normalized title grouping). Surfaces accidental re-publishing and content cannibalization."
argument-hint: "[site] [type] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_duplicate_content
---

Call the `mcp__drupal__drupal_report_duplicate_content` MCP tool.

Find duplicate / near-duplicate titles within a content type (normalized title grouping). Surfaces accidental re-publishing and content cannibalization.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `sampleSize` (number): Max nodes to scan

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
