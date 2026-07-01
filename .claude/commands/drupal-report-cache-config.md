---
description: "Report the site's cache posture (CSS/JS aggregation, anonymous page-cache max-age) from system.performance with plain recommendations. Reads config via the connector's drush bridge (or the governed config server-tool when configured); requires config-read access."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_report_cache_config
---

Call the `mcp__drupal__drupal_report_cache_config` MCP tool.

Report the site's cache posture (CSS/JS aggregation, anonymous page-cache max-age) from system.performance with plain recommendations. Reads config via the connector's drush bridge (or the governed config server-tool when configured); requires config-read access.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
