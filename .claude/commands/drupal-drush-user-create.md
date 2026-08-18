---
description: "Create a Drupal user and optionally assign roles. Requires write access."
argument-hint: "<name> <mail> <password> [site] [roles]"
allowed-tools: mcp__drupal__drupal_drush_user_create
---

Call the `mcp__drupal__drupal_drush_user_create` MCP tool.

Create a Drupal user and optionally assign roles. Requires write access.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `name` (string)
- `mail` (string)
- `password` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `roles` (array (pass as JSON))

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
