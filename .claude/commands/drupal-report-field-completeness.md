---
description: "Score how completely optional fields are filled in for a content type. Finds nodes missing summaries, images, meta descriptions, tags, etc."
argument-hint: "<type> [site] [fields] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_field_completeness
---

Call the `mcp__drupal__drupal_report_field_completeness` MCP tool.

Score how completely optional fields are filled in for a content type. Finds nodes missing summaries, images, meta descriptions, tags, etc.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `fields` (array (pass as JSON)): Field machine names to check. Defaults to common SEO/editorial fields.
- `sampleSize` (number): Max nodes to scan

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
