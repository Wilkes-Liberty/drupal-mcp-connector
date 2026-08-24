---
description: "Surface the Drupal status report (system requirements) entries at warning/error severity — pending updates, overdue cron, missing dependencies, writable settings. Self-sufficient via the connector's drush bridge (drush core:requirements)."
argument-hint: "[site] [minSeverity]"
---

Call the MCP tool `drupal_report_status_report`.

Surface the Drupal status report (system requirements) entries at warning/error severity — pending updates, overdue cron, missing dependencies, writable settings. Self-sufficient via the connector's drush bridge (drush core:requirements).

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `minSeverity` (string): Lowest severity to include

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
