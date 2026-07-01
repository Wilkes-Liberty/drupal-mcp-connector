---
description: "Surface the addressable revisions of a content node: the latest default revision and the working-copy (forward) revision, with their version ids and links. NOTE: JSON:API cannot enumerate full chronological revision history — it only addresses revisions by id or the latest/working-copy aliases. Full history enumeration requires the Drush bridge. Use drupal_report_revision_hotspots for per-node revision counts."
argument-hint: "<type> <id> [site]"
allowed-tools: mcp__drupal__drupal_list_revisions
---

Call the `mcp__drupal__drupal_list_revisions` MCP tool.

Surface the addressable revisions of a content node: the latest default revision and the working-copy (forward) revision, with their version ids and links. NOTE: JSON:API cannot enumerate full chronological revision history — it only addresses revisions by id or the latest/working-copy aliases. Full history enumeration requires the Drush bridge. Use drupal_report_revision_hotspots for per-node revision counts.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name, e.g. 'article'
- `id` (string): Node UUID

**Optional:**
- `site` (string): Named site (omit for default)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
