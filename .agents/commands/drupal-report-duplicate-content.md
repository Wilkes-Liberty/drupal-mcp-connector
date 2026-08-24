---
description: "Find duplicate / near-duplicate titles within a content type (normalized title grouping). Surfaces accidental re-publishing and content cannibalization."
argument-hint: "[site] [type] [sampleSize]"
---

Call the MCP tool `drupal_report_duplicate_content`.

Find duplicate / near-duplicate titles within a content type (normalized title grouping). Surfaces accidental re-publishing and content cannibalization.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type (default: article)
- `sampleSize` (number): Max nodes to scan

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
