---
description: "Upload a local file to Drupal and create a File entity. Returns the file UUID to use when creating a Media entity. For images, the typical flow is: drupal_upload_file → drupal_create_media."
argument-hint: "<filePath> <bundle> <fieldName> [site] [entityType]"
---

Call the MCP tool `drupal_upload_file`.

Upload a local file to Drupal and create a File entity. Returns the file UUID to use when creating a Media entity. For images, the typical flow is: drupal_upload_file → drupal_create_media.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `filePath` (string): Local path to the file (must resolve under MCP_UPLOAD_ROOT or the connector working directory)
- `bundle` (string): Bundle machine name, e.g. 'image', 'article'
- `fieldName` (string): Field machine name, e.g. 'field_media_image', 'field_image'

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `entityType` (string): Drupal entity type (usually 'media' or 'node')

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
