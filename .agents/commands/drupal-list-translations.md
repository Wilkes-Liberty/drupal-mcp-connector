---
description: "List the translation langcode(s) for a Drupal entity (multilingual / content_translation). Reports the language(s) observable on the resource. Core JSON:API serves one language per resource and does not enumerate all translations — see the returned note. Defaults to node."
argument-hint: "<type> <id> [site] [entityType]"
---

Call the MCP tool `drupal_list_translations`.

List the translation langcode(s) for a Drupal entity (multilingual / content_translation). Reports the language(s) observable on the resource. Core JSON:API serves one language per resource and does not enumerate all translations — see the returned note. Defaults to node.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Bundle machine name, e.g. 'article'
- `id` (string): Entity UUID

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `entityType` (string): Entity type machine name. Default: 'node'.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
