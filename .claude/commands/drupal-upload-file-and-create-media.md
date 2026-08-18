---
description: "Convenience tool: upload a local file and immediately create a Media entity in one step. Best for the common 'add an image' workflow. Media defaults to unpublished."
argument-hint: "<filePath> <mediaType> <fieldName> [site] [mediaName] [altText] [status]"
allowed-tools: mcp__drupal__drupal_upload_file_and_create_media
---

Call the `mcp__drupal__drupal_upload_file_and_create_media` MCP tool.

Convenience tool: upload a local file and immediately create a Media entity in one step. Best for the common 'add an image' workflow. Media defaults to unpublished.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `filePath` (string): Local path to the file (must resolve under MCP_UPLOAD_ROOT or the connector working directory)
- `mediaType` (string): Media type machine name, e.g. 'image'
- `fieldName` (string): Source field machine name, e.g. 'field_media_image'

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `mediaName` (string): Name for the media entity (defaults to filename)
- `altText` (string): Alt text for image media
- `status` (boolean (true/false)): Published flag. Defaults to false. Requires allowPublish when true.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
