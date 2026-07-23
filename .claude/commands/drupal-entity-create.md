---
description: "Create an entity of any Drupal entity type and bundle. Use drupal_get_entity_schema first to know what fields are available. All operations checked against security config."
argument-hint: "<entityType> <bundle> [site] [attributes] [relationships] [dryRun] [returning]"
allowed-tools: mcp__drupal__drupal_entity_create
---

Call the `mcp__drupal__drupal_entity_create` MCP tool.

Create an entity of any Drupal entity type and bundle. Use drupal_get_entity_schema first to know what fields are available. All operations checked against security config.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `entityType` (string)
- `bundle` (string)

**Optional:**
- `site` (string): omit for the default site
- `attributes` (object (pass as JSON)): Field values keyed by Drupal machine name
- `relationships` (object (pass as JSON)): Relationship data keyed by field name
- `dryRun` (boolean (true/false)): Validate and return a preview of the create without committing.
- `returning` (string): Response verbosity. "full" (default) returns the complete saved entity; "minimal" returns just identity + state (id, type, bundle, title, status, changed, url) — much smaller, recommended for bulk writes where the echoed body would dominate the response.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
