---
description: "List Drupal user accounts. Filter by active/blocked status or by role machine name."
argument-hint: "[site] [status] [role] [limit] [offset]"
allowed-tools: mcp__drupal__drupal_list_users
---

Call the `mcp__drupal__drupal_list_users` MCP tool.

List Drupal user accounts. Filter by active/blocked status or by role machine name.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `status` (boolean (true/false)): true = active only, false = blocked only
- `role` (string): Filter by role machine name, e.g. 'editor'
- `limit` (number)
- `offset` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
