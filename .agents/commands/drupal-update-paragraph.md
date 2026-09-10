---
description: "Update an existing Paragraph entity's field values by paragraph type (bundle) and UUID. Only the attributes you pass are changed (partial update); the host entity's reference to the paragraph is unchanged (same UUID), so this maintains a component paragraph in place without re-embedding. Pass langcode to continue an unpublished paragraph translation via Sentinel (the host pin, not a live English mutation). Omitting langcode still uses canonical JSON:API and remains gated on published-host children. Returns relationshipData including meta.target_revision_id for a later host attach. Use drupal_get_entity_schema (entityType 'paragraph', the bundle) to discover fields. Governed by the site security policy."
argument-hint: "<paragraphType> <id> [site] [attributes] [langcode] [revisionId] [draftState]"
---

Call the MCP tool `drupal_update_paragraph`.

Update an existing Paragraph entity's field values by paragraph type (bundle) and UUID. Only the attributes you pass are changed (partial update); the host entity's reference to the paragraph is unchanged (same UUID), so this maintains a component paragraph in place without re-embedding. Pass langcode to continue an unpublished paragraph translation via Sentinel (the host pin, not a live English mutation). Omitting langcode still uses canonical JSON:API and remains gated on published-host children. Returns relationshipData including meta.target_revision_id for a later host attach. Use drupal_get_entity_schema (entityType 'paragraph', the bundle) to discover fields. Governed by the site security policy.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `paragraphType` (string): Paragraph type / bundle machine name, e.g. 'text', 'image', 'cta'
- `id` (string): Paragraph UUID

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `attributes` (object (pass as JSON)): Paragraph field values to change, keyed by Drupal machine name, e.g. { field_body: { value: '<p>..</p>', format: 'full_html' } }
- `langcode` (string): Target language for an unpublished paragraph translation (e.g. 'es'). Continues Sentinel /mcp-draft; does not create a missing translation.
- `revisionId` (string): Paragraph revision id the host already pins. Required when that pin is not the default revision.
- `draftState` (string): Required with langcode. Opaque draftState from the previous paragraph draft read/create/update; prevents overwriting newer edits.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
