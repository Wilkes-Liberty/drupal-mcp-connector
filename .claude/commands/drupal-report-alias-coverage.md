---
description: "URL-alias coverage for a content type: nodes whose canonical URL is still /node/N (no alias / pathauto gap), plus conflicting aliases (one alias mapped to multiple system paths) when the path_alias entity is exposed."
argument-hint: "[site] [type] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_alias_coverage
---

Call the `mcp__drupal__drupal_report_alias_coverage` MCP tool.

URL-alias coverage for a content type: nodes whose canonical URL is still /node/N (no alias / pathauto gap), plus conflicting aliases (one alias mapped to multiple system paths) when the path_alias entity is exposed.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `sampleSize` (number): Max nodes to scan

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
