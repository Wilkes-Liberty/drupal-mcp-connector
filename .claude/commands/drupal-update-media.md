---
description: "Update a media entity's name, status, or field values. Partial: omitted fields (status included) are left untouched."
argument-hint: "<type> <id> [site] [name] [status] [fields]"
allowed-tools: mcp__drupal__drupal_update_media
---

Call the `mcp__drupal__drupal_update_media` MCP tool.

Update a media entity's name, status, or field values. Partial: omitted fields (status included) are left untouched.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string)
- `id` (string)

**Optional:**
- `site` (string): omit for the default site
- `name` (string)
- `status` (boolean (true/false)): Published flag. Only sent when provided; requires allowPublish when true.
- `fields` (object (pass as JSON)): Field values. Entity-reference values in JSON:API linkage shape ({ data: { type, id } }) are sent as relationships automatically.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
