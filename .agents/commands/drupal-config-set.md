---
description: "Set a Drupal configuration value via the governed server-side config tool. Audited and gated server-side; requires the config-editor (Developer) tier. Then export to YAML for a PR."
argument-hint: "<name> <value> [site]"
---

Call the MCP tool `drupal_config_set`.

Set a Drupal configuration value via the governed server-side config tool. Audited and gated server-side; requires the config-editor (Developer) tier. Then export to YAML for a PR.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `name` (string)
- `value` (object (pass as JSON)): A map of top-level config keys to their new values (e.g. { "slogan": "Information Technology" }). Other keys in the object are preserved server-side.

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
