---
description: "Create a media entity. For remote video (YouTube/Vimeo), pass the URL via fields.field_media_oembed_video. For file-based media, use drupal_upload_file first to get a file UUID, then pass it in fields."
argument-hint: "[site] <type> <name> [status] [fields]"
allowed-tools: mcp__drupal__drupal_create_media
---

Call the `mcp__drupal__drupal_create_media` MCP tool.

Create a media entity. For remote video (YouTube/Vimeo), pass the URL via fields.field_media_oembed_video. For file-based media, use drupal_upload_file first to get a file UUID, then pass it in fields.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Media type machine name
- `name` (string): Media entity name / label

**Optional:**
- `site` (string): omit for the default site
- `status` (boolean (true/false))
- `fields` (object (pass as JSON)): Additional field values — include the source field (e.g. field_media_oembed_video: 'https://youtu.be/...')

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
