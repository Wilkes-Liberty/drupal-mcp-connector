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
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
