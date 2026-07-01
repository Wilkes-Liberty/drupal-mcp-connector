---
description: "Surface the Drupal status report (system requirements) entries at warning/error severity — pending updates, overdue cron, missing dependencies, writable settings. Self-sufficient via the connector's drush bridge (drush core:requirements)."
argument-hint: "[site] [minSeverity]"
allowed-tools: mcp__drupal__drupal_report_status_report
---

Call the `mcp__drupal__drupal_report_status_report` MCP tool.

Surface the Drupal status report (system requirements) entries at warning/error severity — pending updates, overdue cron, missing dependencies, writable settings. Self-sufficient via the connector's drush bridge (drush core:requirements).

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `minSeverity` (string): Lowest severity to include

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
