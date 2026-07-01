---
description: "Update an existing Paragraph entity's field values by paragraph type (bundle) and UUID. Only the attributes you pass are changed (partial update); the host entity's reference to this paragraph is unchanged (same UUID), so this maintains a component paragraph in place without re-embedding. Use drupal_get_entity_schema (entityType 'paragraph', the bundle) to discover fields. Governed by the site security policy."
argument-hint: "[site] <paragraphType> <id> [attributes]"
allowed-tools: mcp__drupal__drupal_update_paragraph
---

Call the `mcp__drupal__drupal_update_paragraph` MCP tool.

Update an existing Paragraph entity's field values by paragraph type (bundle) and UUID. Only the attributes you pass are changed (partial update); the host entity's reference to this paragraph is unchanged (same UUID), so this maintains a component paragraph in place without re-embedding. Use drupal_get_entity_schema (entityType 'paragraph', the bundle) to discover fields. Governed by the site security policy.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `paragraphType` (string): Paragraph type / bundle machine name, e.g. 'text', 'image', 'cta'
- `id` (string): Paragraph UUID

**Optional:**
- `site` (string): Named site (omit for default)
- `attributes` (object (pass as JSON)): Paragraph field values to change, keyed by Drupal machine name, e.g. { field_body: { value: '<p>..</p>', format: 'full_html' } }

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
