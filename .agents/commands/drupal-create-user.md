---
description: "Create a new Drupal user account with optional roles and password."
argument-hint: "<name> <mail> [site] [password] [status] [roles] [timezone]"
---

Call the MCP tool `drupal_create_user`.

Create a new Drupal user account with optional roles and password.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `name` (string): Username
- `mail` (string): Email address

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `password` (string): Initial password (plaintext — sent over HTTPS)
- `status` (boolean (true/false)): true = active (default)
- `roles` (array (pass as JSON)): Role UUIDs to assign
- `timezone` (string)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
