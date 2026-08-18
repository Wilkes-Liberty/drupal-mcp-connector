---
description: "Uninstall a Drupal module. Irreversible for module-stored data. Confirm with user."
argument-hint: "<moduleName> [site]"
allowed-tools: mcp__drupal__drupal_drush_module_disable
---

Call the `mcp__drupal__drupal_drush_module_disable` MCP tool.

Uninstall a Drupal module. Irreversible for module-stored data. Confirm with user.

> ⚠ **Destructive** — this permanently changes or deletes data. Confirm with the user before calling.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `moduleName` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
