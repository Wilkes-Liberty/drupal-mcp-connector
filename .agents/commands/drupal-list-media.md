---
description: "List media entities by type. Supports filtering by name substring and publish status."
argument-hint: "[site] [type] [status] [name] [limit] [offset]"
---

Call the MCP tool `drupal_list_media`.

List media entities by type. Supports filtering by name substring and publish status.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Media type machine name, e.g. 'image', 'document', 'remote_video'
- `status` (boolean (true/false))
- `name` (string): Filter by name substring
- `limit` (number)
- `offset` (number)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
