---
description: "Fetch a single revision of a content node by version id or alias. `version` may be a numeric vid (e.g. 42), an explicit 'id:<vid>', or the relative aliases 'rel:latest-version' / 'rel:working-copy'. Read-only; attributes are redacted per security policy."
argument-hint: "<type> <id> <version> [site]"
allowed-tools: mcp__drupal__drupal_get_revision
---

Call the `mcp__drupal__drupal_get_revision` MCP tool.

Fetch a single revision of a content node by version id or alias. `version` may be a numeric vid (e.g. 42), an explicit 'id:<vid>', or the relative aliases 'rel:latest-version' / 'rel:working-copy'. Read-only; attributes are redacted per security policy.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name
- `id` (string): Node UUID
- `version` (string): Numeric vid, 'id:<vid>', 'rel:latest-version', or 'rel:working-copy'.

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
