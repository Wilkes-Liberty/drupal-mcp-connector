---
description: "Create many entities of a single type + bundle in one call. Permission is checked once; each item is created independently, so the batch continues past individual failures (partial success). Returns per-item { index, success, id | error } and a summary { created, failed }. Writes default to unpublished/draft."
argument-hint: "<entityType> <bundle> <items> [site]"
allowed-tools: mcp__drupal__drupal_bulk_create
---

Call the `mcp__drupal__drupal_bulk_create` MCP tool.

Create many entities of a single type + bundle in one call. Permission is checked once; each item is created independently, so the batch continues past individual failures (partial success). Returns per-item { index, success, id | error } and a summary { created, failed }. Writes default to unpublished/draft.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `entityType` (string): Entity type machine name, e.g. 'node', 'taxonomy_term'
- `bundle` (string): Bundle machine name, e.g. 'article'
- `items` (array (pass as JSON)): Entities to create. Each is { attributes?, relationships? }.

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
