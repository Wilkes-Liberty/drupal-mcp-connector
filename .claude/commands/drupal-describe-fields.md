---
description: "Introspect the fields of a Drupal entity type + bundle: returns a per-field list of { name, type, kind, cardinality?, approximate }. Read-only. Built on schema SAMPLING (an existing entity), so results are approximate — only populated fields are visible and required/cardinality/allowedValues are inferred from value shape. Authoritative field metadata comes from the Drush bridge (Field API). Use this before creating/updating entities to learn field names."
argument-hint: "<site> <type> [bundle]"
allowed-tools: mcp__drupal__drupal_describe_fields
---

Call the `mcp__drupal__drupal_describe_fields` MCP tool.

Introspect the fields of a Drupal entity type + bundle: returns a per-field list of { name, type, kind, cardinality?, approximate }. Read-only. Built on schema SAMPLING (an existing entity), so results are approximate — only populated fields are visible and required/cardinality/allowedValues are inferred from value shape. Authoritative field metadata comes from the Drush bridge (Field API). Use this before creating/updating entities to learn field names.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `site` (string): Configured site name.
- `type` (string): Entity type machine name, e.g. 'node', 'taxonomy_term', 'user', 'media'.

**Optional:**
- `bundle` (string): Bundle machine name, e.g. 'article'. Defaults to the entity type for single-bundle types (e.g. 'user').

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
