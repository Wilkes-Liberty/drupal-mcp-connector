---
description: "List entities of any Drupal entity type and bundle. Supports structured filters, sorting, pagination, and relationship includes. Use drupal_list_entity_types first to discover available types."
argument-hint: "<entityType> <bundle> [site] [filters] [sort] [include] [limit] [offset]"
---

Call the MCP tool `drupal_entity_list`.

List entities of any Drupal entity type and bundle. Supports structured filters, sorting, pagination, and relationship includes. Use drupal_list_entity_types first to discover available types.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `entityType` (string): Entity type machine name, e.g. 'paragraph', 'block_content', 'commerce_product'
- `bundle` (string): Bundle machine name

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `filters` (array (pass as JSON)): Structured filters: [{ field, op, value }]
- `sort` (array (pass as JSON)): Sort specs: [{ field, dir }]
- `include` (array (pass as JSON)): Relationship field names to sideload
- `limit` (number)
- `offset` (number)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
