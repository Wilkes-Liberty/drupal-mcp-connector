---
description: "Convenience tool: upload a local file and immediately create a Media entity in one step. Best for the common 'add an image' workflow."
argument-hint: "[site] <filePath> <mediaType> [mediaName] <fieldName> [altText] [status]"
allowed-tools: mcp__drupal__drupal_upload_file_and_create_media
---

Call the `mcp__drupal__drupal_upload_file_and_create_media` MCP tool.

Convenience tool: upload a local file and immediately create a Media entity in one step. Best for the common 'add an image' workflow.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `filePath` (string): Absolute local path to the file
- `mediaType` (string): Media type machine name, e.g. 'image'
- `fieldName` (string): Source field machine name, e.g. 'field_media_image'

**Optional:**
- `site` (string): omit for the default site
- `mediaName` (string): Name for the media entity (defaults to filename)
- `altText` (string): Alt text for image media
- `status` (boolean (true/false))

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
