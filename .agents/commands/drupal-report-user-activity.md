---
description: "User activity summary: active vs blocked accounts, never-logged-in users, and users inactive beyond a threshold. Useful for security audits and account hygiene."
argument-hint: "[site] [inactiveDays] [limit]"
---

Call the MCP tool `drupal_report_user_activity`.

User activity summary: active vs blocked accounts, never-logged-in users, and users inactive beyond a threshold. Useful for security audits and account hygiene.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `inactiveDays` (number): Days without login to flag as inactive
- `limit` (number)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
