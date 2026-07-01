---
description: "Score body readability (Flesch Reading Ease) for a content type and flag hard-to-read content and structural issues (no H2 subheadings, multiple H1s)."
argument-hint: "[site] [type] [sampleSize] [hardThreshold]"
allowed-tools: mcp__drupal__drupal_report_readability
---

Call the `mcp__drupal__drupal_report_readability` MCP tool.

Score body readability (Flesch Reading Ease) for a content type and flag hard-to-read content and structural issues (no H2 subheadings, multiple H1s).

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `sampleSize` (number)
- `hardThreshold` (number): Flag content scoring below this

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
