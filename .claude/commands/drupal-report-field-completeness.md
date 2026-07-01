---
description: "Score how completely optional fields are filled in for a content type. Finds nodes missing summaries, images, meta descriptions, tags, etc."
argument-hint: "[site] <type> [fields] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_field_completeness
---

Call the `mcp__drupal__drupal_report_field_completeness` MCP tool.

Score how completely optional fields are filled in for a content type. Finds nodes missing summaries, images, meta descriptions, tags, etc.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name

**Optional:**
- `site` (string): omit for the default site
- `fields` (array (pass as JSON)): Field machine names to check. Defaults to common SEO/editorial fields.
- `sampleSize` (number): Max nodes to scan

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
