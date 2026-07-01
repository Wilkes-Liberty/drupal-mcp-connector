---
description: "Update a media entity's name, status, or field values."
argument-hint: "[site] <type> <id> [name] [status] [fields]"
allowed-tools: mcp__drupal__drupal_update_media
---

Call the `mcp__drupal__drupal_update_media` MCP tool.

Update a media entity's name, status, or field values.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string)
- `id` (string)

**Optional:**
- `site` (string): omit for the default site
- `name` (string)
- `status` (boolean (true/false))
- `fields` (object (pass as JSON))

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
