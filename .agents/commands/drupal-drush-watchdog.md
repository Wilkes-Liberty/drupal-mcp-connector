---
description: "Fetch recent Drupal watchdog/dblog entries. Filter by type or severity level."
argument-hint: "[site] [type] [severity] [limit]"
---

Call the MCP tool `drupal_drush_watchdog`.

Fetch recent Drupal watchdog/dblog entries. Filter by type or severity level.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string)
- `severity` (string)
- `limit` (number)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
