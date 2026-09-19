---
description: "Uninstall a Drupal module. Irreversible for module-stored data. Confirm with user. Refused for a protected module: governance, integrity, secrets, auth and API modules such as mcp_sentinel, audit_chain, key, simple_oauth and jsonapi (see `protectedModules` in drupal_security_info). Only an operator can change that list, in site config. Also refused when the uninstall would cascade to dependents: nothing is uninstalled, the dependents are named, and each must be uninstalled by name first."
argument-hint: "<moduleName> [site]"
---

Call the MCP tool `drupal_drush_module_disable`.

Uninstall a Drupal module. Irreversible for module-stored data. Confirm with user. Refused for a protected module: governance, integrity, secrets, auth and API modules such as mcp_sentinel, audit_chain, key, simple_oauth and jsonapi (see `protectedModules` in drupal_security_info). Only an operator can change that list, in site config. Also refused when the uninstall would cascade to dependents: nothing is uninstalled, the dependents are named, and each must be uninstalled by name first.

> ⚠ **Destructive** — this permanently changes or deletes data. Confirm with the user before calling.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `moduleName` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
