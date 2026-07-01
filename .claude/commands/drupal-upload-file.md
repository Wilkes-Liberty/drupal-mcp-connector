---
description: "Upload a local file to Drupal and create a File entity. Returns the file UUID to use when creating a Media entity. For images, the typical flow is: drupal_upload_file → drupal_create_media."
argument-hint: "[site] <filePath> [entityType] <bundle> <fieldName>"
allowed-tools: mcp__drupal__drupal_upload_file
---

Call the `mcp__drupal__drupal_upload_file` MCP tool.

Upload a local file to Drupal and create a File entity. Returns the file UUID to use when creating a Media entity. For images, the typical flow is: drupal_upload_file → drupal_create_media.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `filePath` (string): Absolute local path to the file to upload
- `bundle` (string): Bundle machine name, e.g. 'image', 'article'
- `fieldName` (string): Field machine name, e.g. 'field_media_image', 'field_image'

**Optional:**
- `site` (string): omit for the default site
- `entityType` (string): Drupal entity type (usually 'media' or 'node')

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
