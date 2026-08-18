---
description: "Delete a taxonomy term. Confirm with the user before calling."
argument-hint: "<vocabulary> <id> [site]"
allowed-tools: mcp__drupal__drupal_delete_taxonomy_term
---

Call the `mcp__drupal__drupal_delete_taxonomy_term` MCP tool.

Delete a taxonomy term. Confirm with the user before calling.

> ⚠ **Destructive** — this permanently changes or deletes data. Confirm with the user before calling.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `vocabulary` (string)
- `id` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
