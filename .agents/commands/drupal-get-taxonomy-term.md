---
description: "Fetch a single taxonomy term by UUID. Pass langcode to request that translation; omit for the default language. JSON:API must negotiate language or the tool errors if a different language is served."
argument-hint: "<vocabulary> <id> [site] [langcode]"
---

Call the MCP tool `drupal_get_taxonomy_term`.

Fetch a single taxonomy term by UUID. Pass langcode to request that translation; omit for the default language. JSON:API must negotiate language or the tool errors if a different language is served.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `vocabulary` (string)
- `id` (string): Term UUID

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `langcode` (string): Translation language (e.g. 'es'). Omit for the default language.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
