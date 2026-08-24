---
description: "Introspect the fields of a Drupal entity type + bundle: returns a per-field list of { name, type, kind, cardinality?, approximate }. Read-only. Built on schema SAMPLING (an existing entity), so results are approximate — only populated fields are visible and required/cardinality/allowedValues are inferred from value shape. Authoritative field metadata comes from the Drush bridge (Field API). Use this before creating/updating entities to learn field names."
argument-hint: "<site> [type] [entityType] [bundle]"
---

Call the MCP tool `drupal_describe_fields`.

Introspect the fields of a Drupal entity type + bundle: returns a per-field list of { name, type, kind, cardinality?, approximate }. Read-only. Built on schema SAMPLING (an existing entity), so results are approximate — only populated fields are visible and required/cardinality/allowedValues are inferred from value shape. Authoritative field metadata comes from the Drush bridge (Field API). Use this before creating/updating entities to learn field names.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

**Optional:**
- `type` (string): Entity type machine name, e.g. 'node', 'taxonomy_term', 'user', 'media'. Alias: `entityType` (as used by the sibling tools).
- `entityType` (string): Alias for `type` — accepted for parity with get_entity_schema / entity_create / entity_update / resolve_reference.
- `bundle` (string): Bundle machine name, e.g. 'article'. Defaults to the entity type for single-bundle types (e.g. 'user').

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
