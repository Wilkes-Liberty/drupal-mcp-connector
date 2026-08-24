---
description: "Create a media entity. For remote video (YouTube/Vimeo), pass the URL via fields.field_media_oembed_video. For file-based media, use drupal_upload_file first to get a file UUID, then pass it in fields."
argument-hint: "<type> <name> [site] [status] [fields]"
---

Call the MCP tool `drupal_create_media`.

Create a media entity. For remote video (YouTube/Vimeo), pass the URL via fields.field_media_oembed_video. For file-based media, use drupal_upload_file first to get a file UUID, then pass it in fields.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Media type machine name
- `name` (string): Media entity name / label

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `status` (boolean (true/false)): Published flag. Defaults to false (unpublished). Requires allowPublish when true.
- `fields` (object (pass as JSON)): Additional field values — include the source field (e.g. field_media_oembed_video: 'https://youtu.be/...'). Entity-reference values in JSON:API linkage shape ({ data: { type, id } }) are sent as relationships automatically.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
