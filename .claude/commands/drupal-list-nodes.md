---
description: "List nodes of a given content type. Supports status filtering, pagination, sorting, and structured filter descriptors."
argument-hint: "<type> [site] [status] [limit] [offset] [filters] [sort]"
allowed-tools: mcp__drupal__drupal_list_nodes
---

Call the `mcp__drupal__drupal_list_nodes` MCP tool.

List nodes of a given content type. Supports status filtering, pagination, sorting, and structured filter descriptors.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name

**Optional:**
- `site` (string): omit for the default site
- `status` (boolean (true/false)): true = published only, false = unpublished only, omit = all
- `limit` (number)
- `offset` (number)
- `filters` (array (pass as JSON)): Structured filters: [{ field, op, value }]. op: eq|neq|gt|gte|lt|lte|contains|in|isNull
- `sort` (array (pass as JSON)): Sort specs: [{ field, dir }] where dir is 'asc'|'desc'

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
