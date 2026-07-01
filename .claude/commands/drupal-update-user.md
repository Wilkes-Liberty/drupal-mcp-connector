---
description: "Update a Drupal user account. Only include fields you want to change. Can reassign roles by providing a full replacement role list."
argument-hint: "<id> [site] [name] [mail] [password] [status] [roles] [timezone]"
allowed-tools: mcp__drupal__drupal_update_user
---

Call the `mcp__drupal__drupal_update_user` MCP tool.

Update a Drupal user account. Only include fields you want to change. Can reassign roles by providing a full replacement role list.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `id` (string): User UUID

**Optional:**
- `site` (string): omit for the default site
- `name` (string)
- `mail` (string)
- `password` (string)
- `status` (boolean (true/false))
- `roles` (array (pass as JSON)): Full replacement role UUID list
- `timezone` (string)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
