---
description: "Report structured-meta (SEO) coverage for a content type: how many sampled nodes populate each meta field (metatag, meta description). Complements drupal_report_seo_audit with explicit per-field coverage."
argument-hint: "[site] [type] [fields] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_seo_meta_coverage
---

Call the `mcp__drupal__drupal_report_seo_meta_coverage` MCP tool.

Report structured-meta (SEO) coverage for a content type: how many sampled nodes populate each meta field (metatag, meta description). Complements drupal_report_seo_audit with explicit per-field coverage.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `fields` (array (pass as JSON)): Meta field machine names to check
- `sampleSize` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
