---
description: "List Drupal users via Drush. Filter by active/blocked status or role."
argument-hint: "[site] [status] [role] [limit]"
allowed-tools: mcp__drupal__drupal_drush_user_list
---

Call the `mcp__drupal__drupal_drush_user_list` MCP tool.

List Drupal users via Drush. Filter by active/blocked status or role.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `status` (string)
- `role` (string)
- `limit` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
