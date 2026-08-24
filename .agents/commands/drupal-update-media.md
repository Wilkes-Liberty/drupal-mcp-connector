---
description: "Update a media entity's name, status, or field values. Partial: omitted fields (status included) are left untouched."
argument-hint: "<type> <id> [site] [name] [status] [fields]"
---

Call the MCP tool `drupal_update_media`.

Update a media entity's name, status, or field values. Partial: omitted fields (status included) are left untouched.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string)
- `id` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `name` (string)
- `status` (boolean (true/false)): Published flag. Only sent when provided; requires allowPublish when true.
- `fields` (object (pass as JSON)): Field values. Entity-reference values in JSON:API linkage shape ({ data: { type, id } }) are sent as relationships automatically.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
