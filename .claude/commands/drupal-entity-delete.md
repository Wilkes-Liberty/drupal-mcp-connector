---
description: "Delete an entity of any Drupal entity type. Requires allowDestructive = true in security config. Confirm with the user before calling."
argument-hint: "[site] <entityType> <bundle> <id> [dryRun]"
allowed-tools: mcp__drupal__drupal_entity_delete
---

Call the `mcp__drupal__drupal_entity_delete` MCP tool.

Delete an entity of any Drupal entity type. Requires allowDestructive = true in security config. Confirm with the user before calling.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `entityType` (string)
- `bundle` (string)
- `id` (string)

**Optional:**
- `site` (string): omit for the default site
- `dryRun` (boolean (true/false)): Validate and return a preview of the delete without committing.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
