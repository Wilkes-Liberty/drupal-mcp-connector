---
description: "Create a translation as an unpublished non-default draft revision (governed write). Adds the target language beside the default language; it does not PATCH langcode on the canonical entity. English live title, body, status, alias, and default revision stay unchanged. An existing translation is a conflict, not an overwrite. Continue the draft with drupal_update_node and langcode. Requires Sentinel's draft-translation endpoint and a translatable bundle. Paragraph field values are not translated on this path. Defaults to node. Publication stays denied for content-tier callers."
argument-hint: "<type> <id> <langcode> [site] [entityType] [attributes] [dryRun]"
---

Call the MCP tool `drupal_create_translation`.

Create a translation as an unpublished non-default draft revision (governed write). Adds the target language beside the default language; it does not PATCH langcode on the canonical entity. English live title, body, status, alias, and default revision stay unchanged. An existing translation is a conflict, not an overwrite. Continue the draft with drupal_update_node and langcode. Requires Sentinel's draft-translation endpoint and a translatable bundle. Paragraph field values are not translated on this path. Defaults to node. Publication stays denied for content-tier callers.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Bundle machine name, e.g. 'basic_page'
- `id` (string): Entity UUID
- `langcode` (string): Target language code, e.g. 'es', 'de', 'pt-br'

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `entityType` (string): Entity type machine name. Default: 'node'.
- `attributes` (object (pass as JSON)): Translated field values keyed by Drupal machine name
- `dryRun` (boolean (true/false)): Validate without saving

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
