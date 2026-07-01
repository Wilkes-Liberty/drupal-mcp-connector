---
description: "List entities of any Drupal entity type and bundle. Supports structured filters, sorting, pagination, and relationship includes. Use drupal_list_entity_types first to discover available types."
argument-hint: "<entityType> <bundle> [site] [filters] [sort] [include] [limit] [offset]"
allowed-tools: mcp__drupal__drupal_entity_list
---

Call the `mcp__drupal__drupal_entity_list` MCP tool.

List entities of any Drupal entity type and bundle. Supports structured filters, sorting, pagination, and relationship includes. Use drupal_list_entity_types first to discover available types.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `entityType` (string): Entity type machine name, e.g. 'paragraph', 'block_content', 'commerce_product'
- `bundle` (string): Bundle machine name

**Optional:**
- `site` (string): omit for the default site
- `filters` (array (pass as JSON)): Structured filters: [{ field, op, value }]
- `sort` (array (pass as JSON)): Sort specs: [{ field, dir }]
- `include` (array (pass as JSON)): Relationship field names to sideload
- `limit` (number)
- `offset` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
