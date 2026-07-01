---
description: "Create a Drupal user and optionally assign roles. Requires write access."
argument-hint: "[site] <name> <mail> <password> [roles]"
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
- `site` (string): omit for the default site
- `roles` (array (pass as JSON))

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
