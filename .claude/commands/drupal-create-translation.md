---
description: "Create or replace a translation of a Drupal entity for a target language (governed write). Sets the given langcode plus the supplied translated field values. Requires the content_translation module enabled and the bundle configured as translatable; otherwise Drupal rejects the write. Defaults to node."
argument-hint: "[site] [entityType] <type> <id> <langcode> [attributes]"
allowed-tools: mcp__drupal__drupal_create_translation
---

Call the `mcp__drupal__drupal_create_translation` MCP tool.

Create or replace a translation of a Drupal entity for a target language (governed write). Sets the given langcode plus the supplied translated field values. Requires the content_translation module enabled and the bundle configured as translatable; otherwise Drupal rejects the write. Defaults to node.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Bundle machine name, e.g. 'article'
- `id` (string): Entity UUID
- `langcode` (string): Target language code, e.g. 'de', 'fr', 'pt_br'

**Optional:**
- `site` (string): omit for the default site
- `entityType` (string): Entity type machine name. Default: 'node'.
- `attributes` (object (pass as JSON)): Translated field values keyed by Drupal machine name

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
