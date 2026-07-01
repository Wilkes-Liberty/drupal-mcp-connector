---
description: "Find media entities not referenced by any content. Useful for storage cleanup audits."
argument-hint: "[site] [type] [limit]"
allowed-tools: mcp__drupal__drupal_find_orphaned_media
---

Call the `mcp__drupal__drupal_find_orphaned_media` MCP tool.

Find media entities not referenced by any content. Useful for storage cleanup audits.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Media type to check (default: image)
- `limit` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
