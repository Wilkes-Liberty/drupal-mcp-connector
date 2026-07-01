---
description: "List the translation langcode(s) for a Drupal entity (multilingual / content_translation). Reports the language(s) observable on the resource. Core JSON:API serves one language per resource and does not enumerate all translations — see the returned note. Defaults to node."
argument-hint: "[site] [entityType] <type> <id>"
allowed-tools: mcp__drupal__drupal_list_translations
---

Call the `mcp__drupal__drupal_list_translations` MCP tool.

List the translation langcode(s) for a Drupal entity (multilingual / content_translation). Reports the language(s) observable on the resource. Core JSON:API serves one language per resource and does not enumerate all translations — see the returned note. Defaults to node.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Bundle machine name, e.g. 'article'
- `id` (string): Entity UUID

**Optional:**
- `site` (string): Named site (omit for default)
- `entityType` (string): Entity type machine name. Default: 'node'.

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
