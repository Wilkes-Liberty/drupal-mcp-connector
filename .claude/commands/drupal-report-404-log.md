---
description: "Aggregate Drupal 'page not found' (404) log events into the top missing URLs ranked by hit count — the redirect-candidate list. Self-sufficient via the connector's drush watchdog bridge; returns an 'unavailable' payload when drush isn't configured for the site."
argument-hint: "[site] [limit]"
allowed-tools: mcp__drupal__drupal_report_404_log
---

Call the `mcp__drupal__drupal_report_404_log` MCP tool.

Aggregate Drupal 'page not found' (404) log events into the top missing URLs ranked by hit count — the redirect-candidate list. Self-sufficient via the connector's drush watchdog bridge; returns an 'unavailable' payload when drush isn't configured for the site.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `limit` (number): Max distinct missing paths to return (max 200)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
