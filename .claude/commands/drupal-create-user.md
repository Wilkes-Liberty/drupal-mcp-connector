---
description: "Create a new Drupal user account with optional roles and password."
argument-hint: "[site] <name> <mail> [password] [status] [roles] [timezone]"
allowed-tools: mcp__drupal__drupal_create_user
---

Call the `mcp__drupal__drupal_create_user` MCP tool.

Create a new Drupal user account with optional roles and password.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `name` (string): Username
- `mail` (string): Email address

**Optional:**
- `site` (string): omit for the default site
- `password` (string): Initial password (plaintext — sent over HTTPS)
- `status` (boolean (true/false)): true = active (default)
- `roles` (array (pass as JSON)): Role UUIDs to assign
- `timezone` (string)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
