---
description: "List media entities by type. Supports filtering by name substring and publish status."
argument-hint: "[site] [type] [status] [name] [limit] [offset]"
allowed-tools: mcp__drupal__drupal_list_media
---

Call the `mcp__drupal__drupal_list_media` MCP tool.

List media entities by type. Supports filtering by name substring and publish status.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Media type machine name, e.g. 'image', 'document', 'remote_video'
- `status` (boolean (true/false))
- `name` (string): Filter by name substring
- `limit` (number)
- `offset` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
