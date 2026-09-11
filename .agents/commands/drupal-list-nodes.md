---
description: "List nodes of a given content type. Supports status filtering, pagination, sorting, and structured filter descriptors. Drupal core JSON:API caps page[limit] at 50; a larger requested limit is filled by following links.next (up to 1000). When the site does not expose meta.count, total is exact only if this window reached the end of the collection; otherwise approximate is true and hasNext is set."
argument-hint: "<type> [site] [status] [limit] [offset] [filters] [sort]"
---

Call the MCP tool `drupal_list_nodes`.

List nodes of a given content type. Supports status filtering, pagination, sorting, and structured filter descriptors. Drupal core JSON:API caps page[limit] at 50; a larger requested limit is filled by following links.next (up to 1000). When the site does not expose meta.count, total is exact only if this window reached the end of the collection; otherwise approximate is true and hasNext is set.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Content type machine name

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `status` (boolean (true/false)): true = published only, false = unpublished only, omit = all
- `limit` (number)
- `offset` (number)
- `filters` (array (pass as JSON)): Structured filters: [{ field, op, value }]. op: eq|neq|gt|gte|lt|lte|contains|in|isNull
- `sort` (array (pass as JSON)): Sort specs: [{ field, dir }] where dir is 'asc'|'desc'

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
