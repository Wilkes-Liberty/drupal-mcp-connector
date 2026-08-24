---
description: "Create an entity of any Drupal entity type and bundle. Use drupal_get_entity_schema first to know what fields are available. All operations checked against security config."
argument-hint: "<entityType> <bundle> [site] [attributes] [relationships] [dryRun] [returning]"
---

Call the MCP tool `drupal_entity_create`.

Create an entity of any Drupal entity type and bundle. Use drupal_get_entity_schema first to know what fields are available. All operations checked against security config.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `entityType` (string)
- `bundle` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `attributes` (object (pass as JSON)): Field values keyed by Drupal machine name
- `relationships` (object (pass as JSON)): Relationship data keyed by field name
- `dryRun` (boolean (true/false)): Validate and return a preview of the create without committing.
- `returning` (string): Response verbosity. "full" (default) returns the complete saved entity; "minimal" returns just identity + state (id, type, bundle, title, status, changed, url) — much smaller, recommended for bulk writes where the echoed body would dominate the response.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
