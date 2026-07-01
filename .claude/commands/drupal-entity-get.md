---
description: "Fetch a single entity of any Drupal entity type by UUID."
argument-hint: "<entityType> <bundle> <id> [site] [include]"
allowed-tools: mcp__drupal__drupal_entity_get
---

Call the `mcp__drupal__drupal_entity_get` MCP tool.

Fetch a single entity of any Drupal entity type by UUID.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `entityType` (string)
- `bundle` (string)
- `id` (string): Entity UUID

**Optional:**
- `site` (string): omit for the default site
- `include` (array (pass as JSON)): Relationship field names to sideload

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
