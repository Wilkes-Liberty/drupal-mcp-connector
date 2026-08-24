---
description: "Create a Drupal user and optionally assign roles. Requires write access."
argument-hint: "<name> <mail> <password> [site] [roles]"
---

Call the MCP tool `drupal_drush_user_create`.

Create a Drupal user and optionally assign roles. Requires write access.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `name` (string)
- `mail` (string)
- `password` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `roles` (array (pass as JSON))

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
