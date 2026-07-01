---
description: "Fetch a single media entity by UUID and media type."
argument-hint: "[site] <type> <id>"
allowed-tools: mcp__drupal__drupal_get_media
---

Call the `mcp__drupal__drupal_get_media` MCP tool.

Fetch a single media entity by UUID and media type.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string)
- `id` (string): Media entity UUID

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
