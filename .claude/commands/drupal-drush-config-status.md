---
description: "Check if active config is in sync with the sync directory. Returns out-of-sync items if any."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_drush_config_status
---

Call the `mcp__drupal__drupal_drush_config_status` MCP tool.

Check if active config is in sync with the sync directory. Returns out-of-sync items if any.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
