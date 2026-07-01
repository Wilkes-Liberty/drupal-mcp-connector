---
description: "Report content distribution by language for a content type and flag languages lagging the most-populated language — a multilingual coverage signal."
argument-hint: "[site] [type] [gapThreshold] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_translation_coverage
---

Call the `mcp__drupal__drupal_report_translation_coverage` MCP tool.

Report content distribution by language for a content type and flag languages lagging the most-populated language — a multilingual coverage signal.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `gapThreshold` (number): Flag languages below this fraction of the top language
- `sampleSize` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
