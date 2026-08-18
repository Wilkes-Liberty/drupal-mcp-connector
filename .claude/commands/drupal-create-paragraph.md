---
description: "Create a Paragraph entity of a given paragraph type (bundle). Paragraphs are content fragments that are NOT standalone — they must be referenced by a host entity's paragraph / Entity Reference Revisions field. Returns the created paragraph plus `relationshipData` ({ type: 'paragraph--<bundle>', id, meta: { target_revision_id } }) to drop into a host field's relationships via drupal_entity_update / drupal_update_node. Drupal ERR items are empty without that meta key — do not send {type, id} alone. Before creating paragraphs to attach to a published moderated node, call drupal_list_revisions (possiblyPatchBlocked) and dryRun the host update so a doomed PATCH does not orphan them. Use drupal_get_entity_schema (entityType 'paragraph', the bundle) first to discover fields. Governed by the site security policy."
argument-hint: "<paragraphType> [site] [attributes]"
allowed-tools: mcp__drupal__drupal_create_paragraph
---

Call the `mcp__drupal__drupal_create_paragraph` MCP tool.

Create a Paragraph entity of a given paragraph type (bundle). Paragraphs are content fragments that are NOT standalone — they must be referenced by a host entity's paragraph / Entity Reference Revisions field. Returns the created paragraph plus `relationshipData` ({ type: 'paragraph--<bundle>', id, meta: { target_revision_id } }) to drop into a host field's relationships via drupal_entity_update / drupal_update_node. Drupal ERR items are empty without that meta key — do not send {type, id} alone. Before creating paragraphs to attach to a published moderated node, call drupal_list_revisions (possiblyPatchBlocked) and dryRun the host update so a doomed PATCH does not orphan them. Use drupal_get_entity_schema (entityType 'paragraph', the bundle) first to discover fields. Governed by the site security policy.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `paragraphType` (string): Paragraph type / bundle machine name, e.g. 'text', 'image', 'cta'

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `attributes` (object (pass as JSON)): Paragraph field values keyed by Drupal machine name, e.g. { field_body: { value: '<p>..</p>', format: 'full_html' } }

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
