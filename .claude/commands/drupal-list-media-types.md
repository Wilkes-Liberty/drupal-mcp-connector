---
description: "List all media types defined on this Drupal site (image, document, remote_video, audio, etc.)."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_list_media_types
---

Call the `mcp__drupal__drupal_list_media_types` MCP tool.

List all media types defined on this Drupal site (image, document, remote_video, audio, etc.).

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
