---
description: "Scan published body content for accidentally exposed PII (emails, US SSNs, phone numbers). Matched values are masked in the output so the report itself doesn't leak data."
argument-hint: "[site] [type] [sampleSize] [kinds]"
allowed-tools: mcp__drupal__drupal_report_pii_exposure
---

Call the `mcp__drupal__drupal_report_pii_exposure` MCP tool.

Scan published body content for accidentally exposed PII (emails, US SSNs, phone numbers). Matched values are masked in the output so the report itself doesn't leak data.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type (default: article)
- `sampleSize` (number)
- `kinds` (array (pass as JSON)): PII kinds to scan (default: all)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
