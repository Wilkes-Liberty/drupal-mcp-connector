---
description: "Report structured-meta (SEO) coverage for a content type: how many sampled nodes populate each meta field (metatag, meta description). Complements drupal_report_seo_audit with explicit per-field coverage."
argument-hint: "[site] [type] [fields] [sampleSize]"
---

Call the MCP tool `drupal_report_seo_meta_coverage`.

Report structured-meta (SEO) coverage for a content type: how many sampled nodes populate each meta field (metatag, meta description). Complements drupal_report_seo_audit with explicit per-field coverage.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type (default: article)
- `fields` (array (pass as JSON)): Meta field machine names to check
- `sampleSize` (number)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
