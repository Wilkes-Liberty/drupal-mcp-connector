---
description: "User activity summary: active vs blocked accounts, never-logged-in users, and users inactive beyond a threshold. Useful for security audits and account hygiene."
argument-hint: "[site] [inactiveDays] [limit]"
allowed-tools: mcp__drupal__drupal_report_user_activity
---

Call the `mcp__drupal__drupal_report_user_activity` MCP tool.

User activity summary: active vs blocked accounts, never-logged-in users, and users inactive beyond a threshold. Useful for security audits and account hygiene.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `inactiveDays` (number): Days without login to flag as inactive
- `limit` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
