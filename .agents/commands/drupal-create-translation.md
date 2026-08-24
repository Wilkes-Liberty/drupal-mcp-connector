---
description: "Create or replace a translation of a Drupal entity for a target language (governed write). Sets the given langcode plus the supplied translated field values. Requires the content_translation module enabled and the bundle configured as translatable; otherwise Drupal rejects the write. Defaults to node."
argument-hint: "<type> <id> <langcode> [site] [entityType] [attributes]"
---

Call the MCP tool `drupal_create_translation`.

Create or replace a translation of a Drupal entity for a target language (governed write). Sets the given langcode plus the supplied translated field values. Requires the content_translation module enabled and the bundle configured as translatable; otherwise Drupal rejects the write. Defaults to node.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Bundle machine name, e.g. 'article'
- `id` (string): Entity UUID
- `langcode` (string): Target language code, e.g. 'de', 'fr', 'pt_br'

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `entityType` (string): Entity type machine name. Default: 'node'.
- `attributes` (object (pass as JSON)): Translated field values keyed by Drupal machine name

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
