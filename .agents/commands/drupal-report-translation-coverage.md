---
description: "Per-node translation coverage from Sentinel's inventory (missing non-default language, outdated core flag, language counts). Without Sentinel the report is unavailable — JSON:API only shows the default language, so a histogram would be misleading."
argument-hint: "[site] [type] [sampleSize]"
---

Call the MCP tool `drupal_report_translation_coverage`.

Per-node translation coverage from Sentinel's inventory (missing non-default language, outdated core flag, language counts). Without Sentinel the report is unavailable — JSON:API only shows the default language, so a histogram would be misleading.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type (default: article)
- `sampleSize` (number): Max nodes to inventory

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
