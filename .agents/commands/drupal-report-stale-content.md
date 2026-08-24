---
description: "Find content that hasn't been updated in N days. Returns a sorted list with titles, status, and days-since-update."
argument-hint: "[site] [type] [days] [status] [limit]"
---

Call the MCP tool `drupal_report_stale_content`.

Find content that hasn't been updated in N days. Returns a sorted list with titles, status, and days-since-update.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type (default: article)
- `days` (number): Stale threshold in days
- `status` (boolean (true/false)): Filter by publish status
- `limit` (number)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
