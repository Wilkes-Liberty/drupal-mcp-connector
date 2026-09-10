---
description: "Create a translation as an unpublished non-default draft (governed write). Adds the target language beside the default language; it does not PATCH langcode on the canonical entity. When an English working draft already exists, both live and working revision IDs are sent (If-Match) so Sentinel will add the language on that draft (#282). English live title, body, status, alias, default revision, and paragraph ERR pins stay unchanged. An existing translation is a conflict, not an overwrite. The response includes `_revisions.live` / `_revisions.working` when known. Computed `metatag` is omitted on the draft body because JSON:API resolves it from the live default (#283); use field_metatags. Continue a node draft with drupal_update_node and langcode; continue a paragraph with drupal_update_paragraph and langcode. Image alt is a relationship (same file UUID, meta.alt). For paragraphs pass revisionId as the host pin. Requires Sentinel's draft-translation endpoint. Publication stays denied for content-tier callers."
argument-hint: "<type> <id> <langcode> [site] [entityType] [attributes] [relationships] [revisionId] [dryRun]"
---

Call the MCP tool `drupal_create_translation`.

Create a translation as an unpublished non-default draft (governed write). Adds the target language beside the default language; it does not PATCH langcode on the canonical entity. When an English working draft already exists, both live and working revision IDs are sent (If-Match) so Sentinel will add the language on that draft (#282). English live title, body, status, alias, default revision, and paragraph ERR pins stay unchanged. An existing translation is a conflict, not an overwrite. The response includes `_revisions.live` / `_revisions.working` when known. Computed `metatag` is omitted on the draft body because JSON:API resolves it from the live default (#283); use field_metatags. Continue a node draft with drupal_update_node and langcode; continue a paragraph with drupal_update_paragraph and langcode. Image alt is a relationship (same file UUID, meta.alt). For paragraphs pass revisionId as the host pin. Requires Sentinel's draft-translation endpoint. Publication stays denied for content-tier callers.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Bundle machine name, e.g. 'basic_page' or 'p_hero'
- `id` (string): Entity UUID
- `langcode` (string): Target language code, e.g. 'es', 'de', 'pt-br'

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `entityType` (string): Entity type machine name. Default: 'node'. Use 'paragraph' for paragraph field values.
- `attributes` (object (pass as JSON)): Translated field values keyed by Drupal machine name
- `relationships` (object (pass as JSON)): JSON:API relationships. Use for image alt (same file UUID, meta.alt).
- `revisionId` (string): Paragraph revision id the host already pins. Required for Home-shaped non-default pins.
- `dryRun` (boolean (true/false)): Validate without saving

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
