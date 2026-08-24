---
description: "Update a Drupal user account. Only include fields you want to change. Can reassign roles by providing a full replacement role list."
argument-hint: "<id> [site] [name] [mail] [password] [status] [roles] [timezone]"
---

Call the MCP tool `drupal_update_user`.

Update a Drupal user account. Only include fields you want to change. Can reassign roles by providing a full replacement role list.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `id` (string): User UUID

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `name` (string)
- `mail` (string)
- `password` (string)
- `status` (boolean (true/false))
- `roles` (array (pass as JSON)): Full replacement role UUID list
- `timezone` (string)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
