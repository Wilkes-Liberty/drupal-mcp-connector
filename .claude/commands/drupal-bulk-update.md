---
description: "Update many entities of a single type + bundle in one call. Permission is checked once; each item is updated independently, so the batch continues past individual failures (partial success). Each item requires an 'id' (UUID); items missing an id are reported as per-item failures. Returns per-item { index, success, id | error } and a summary { updated, failed }."
argument-hint: "[site] <entityType> <bundle> <items>"
allowed-tools: mcp__drupal__drupal_bulk_update
---

Call the `mcp__drupal__drupal_bulk_update` MCP tool.

Update many entities of a single type + bundle in one call. Permission is checked once; each item is updated independently, so the batch continues past individual failures (partial success). Each item requires an 'id' (UUID); items missing an id are reported as per-item failures. Returns per-item { index, success, id | error } and a summary { updated, failed }.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `entityType` (string): Entity type machine name
- `bundle` (string): Bundle machine name
- `items` (array (pass as JSON)): Entities to update. Each is { id, attributes?, relationships? }.

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
