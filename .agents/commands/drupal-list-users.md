---
description: "List Drupal user accounts. Filter by active/blocked status or by role machine name."
argument-hint: "[site] [status] [role] [limit] [offset]"
---

Call the MCP tool `drupal_list_users`.

List Drupal user accounts. Filter by active/blocked status or by role machine name.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `status` (boolean (true/false)): true = active only, false = blocked only
- `role` (string): Filter by role machine name, e.g. 'editor'
- `limit` (number)
- `offset` (number)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
