---
description: "Revert a content node to a prior revision (GOVERNED WRITE). Reads the target revision and replays its editable content as a NEW current revision (history is preserved, nothing is deleted). Internal ids, revision metadata, and computed paths are not written back. Subject to the site's write security policy. Confirm with the user before calling."
argument-hint: "<type> <id> <version> [site]"
allowed-tools: mcp__drupal__drupal_revert_revision
---

Call the `mcp__drupal__drupal_revert_revision` MCP tool.

Revert a content node to a prior revision (GOVERNED WRITE). Reads the target revision and replays its editable content as a NEW current revision (history is preserved, nothing is deleted). Internal ids, revision metadata, and computed paths are not written back. Subject to the site's write security policy. Confirm with the user before calling.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name
- `id` (string): Node UUID
- `version` (string): Revision to restore: numeric vid, 'id:<vid>', 'rel:latest-version', or 'rel:working-copy'.

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
