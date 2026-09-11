---
description: "Fetch a single Drupal content node by UUID and content type. Returns title, body, status, path alias, and all attributes. Pass langcode to read a working translation draft via Sentinel (distinct from published English). Pass includeComponents true to attach pinned paragraph translations under `components` (default false)."
argument-hint: "<type> <id> [site] [langcode] [includeComponents]"
---

Call the MCP tool `drupal_get_node`.

Fetch a single Drupal content node by UUID and content type. Returns title, body, status, path alias, and all attributes. Pass langcode to read a working translation draft via Sentinel (distinct from published English). Pass includeComponents true to attach pinned paragraph translations under `components` (default false).

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Content type machine name, e.g. 'article'
- `id` (string): Node UUID

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `langcode` (string): Target language (e.g. 'es') to read the unpublished working translation instead of the default language.
- `includeComponents` (boolean (true/false)): If true, include pinned paragraph translations under `components` (empty array when the host has no ERR fields). Default false so existing callers are unchanged.

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
