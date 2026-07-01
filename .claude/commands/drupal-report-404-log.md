---
description: "Aggregate Drupal 'page not found' (404) log events into the top missing URLs ranked by hit count — the redirect-candidate list. Self-sufficient via the connector's drush watchdog bridge; returns an 'unavailable' payload when drush isn't configured for the site."
argument-hint: "[site] [limit]"
allowed-tools: mcp__drupal__drupal_report_404_log
---

Call the `mcp__drupal__drupal_report_404_log` MCP tool.

Aggregate Drupal 'page not found' (404) log events into the top missing URLs ranked by hit count — the redirect-candidate list. Self-sufficient via the connector's drush watchdog bridge; returns an 'unavailable' payload when drush isn't configured for the site.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `limit` (number): Max distinct missing paths to return (max 200)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
