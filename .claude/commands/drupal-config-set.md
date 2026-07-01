---
description: "Set a Drupal configuration value via the governed server-side config tool. Audited and gated server-side; requires the config-editor (Developer) tier. Then export to YAML for a PR."
argument-hint: "<name> <value> [site]"
allowed-tools: mcp__drupal__drupal_config_set
---

Call the `mcp__drupal__drupal_config_set` MCP tool.

Set a Drupal configuration value via the governed server-side config tool. Audited and gated server-side; requires the config-editor (Developer) tier. Then export to YAML for a PR.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `name` (string)
- `value` (object (pass as JSON)): A map of top-level config keys to their new values (e.g. { "slogan": "Information Technology" }). Other keys in the object are preserved server-side.

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
