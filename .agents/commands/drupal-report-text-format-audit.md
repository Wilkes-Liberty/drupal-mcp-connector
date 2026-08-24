---
description: "Audit text formats for ones that permit unfiltered HTML (filter_html not enabled), which are dangerous if exposed to untrusted roles. Reads filter.format.* via the connector's drush bridge (or the governed config server-tool when configured); requires config-read access."
argument-hint: "[site]"
---

Call the MCP tool `drupal_report_text_format_audit`.

Audit text formats for ones that permit unfiltered HTML (filter_html not enabled), which are dangerous if exposed to untrusted roles. Reads filter.format.* via the connector's drush bridge (or the governed config server-tool when configured); requires config-read access.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
