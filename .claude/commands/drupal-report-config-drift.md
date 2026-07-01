---
description: "Report whether active configuration matches the sync directory, as an added/changed/removed breakdown. Self-sufficient via the connector's drush bridge (drush config:status); returns 'unavailable' when drush isn't configured for the site."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_report_config_drift
---

Call the `mcp__drupal__drupal_report_config_drift` MCP tool.

Report whether active configuration matches the sync directory, as an added/changed/removed breakdown. Self-sufficient via the connector's drush bridge (drush config:status); returns 'unavailable' when drush isn't configured for the site.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
