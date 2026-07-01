---
description: "Delete a media entity. Does not delete the underlying File entity. Confirm with the user before calling."
argument-hint: "[site] <type> <id>"
allowed-tools: mcp__drupal__drupal_delete_media
---

Call the `mcp__drupal__drupal_delete_media` MCP tool.

Delete a media entity. Does not delete the underlying File entity. Confirm with the user before calling.

> ⚠ **Destructive** — this permanently changes or deletes data. Confirm with the user before calling.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string)
- `id` (string)

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
