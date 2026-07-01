---
description: "Inspect the fields and relationships available on any Drupal entity type + bundle. Run this before creating or updating entities to know what fields are available."
argument-hint: "<entityType> <bundle> [site]"
allowed-tools: mcp__drupal__drupal_get_entity_schema
---

Call the `mcp__drupal__drupal_get_entity_schema` MCP tool.

Inspect the fields and relationships available on any Drupal entity type + bundle. Run this before creating or updating entities to know what fields are available.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `entityType` (string): e.g. 'node', 'paragraph', 'commerce_product', 'block_content'
- `bundle` (string): e.g. 'article', 'text', 'default'

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
