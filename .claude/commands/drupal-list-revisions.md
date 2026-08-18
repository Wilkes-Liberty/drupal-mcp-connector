---
description: "Surface the addressable revisions of a content node: the latest default revision and the working-copy (forward) revision, with their version ids and links. workingCopy: null is not an all-clear — Drupal core can still reject PATCH when a revision row sits above the default without a content_moderation working copy (#201). The payload includes possiblyPatchBlocked (true when default changed is later than its revision_timestamp) plus changed and revisionTimestamp on latestVersion. Probe the host (this flag, then dryRun on the update) before creating dependent paragraphs. NOTE: JSON:API cannot enumerate full chronological revision history. Full history enumeration requires the Drush bridge."
argument-hint: "<type> <id> [site]"
allowed-tools: mcp__drupal__drupal_list_revisions
---

Call the `mcp__drupal__drupal_list_revisions` MCP tool.

Surface the addressable revisions of a content node: the latest default revision and the working-copy (forward) revision, with their version ids and links. workingCopy: null is not an all-clear — Drupal core can still reject PATCH when a revision row sits above the default without a content_moderation working copy (#201). The payload includes possiblyPatchBlocked (true when default changed is later than its revision_timestamp) plus changed and revisionTimestamp on latestVersion. Probe the host (this flag, then dryRun on the update) before creating dependent paragraphs. NOTE: JSON:API cannot enumerate full chronological revision history. Full history enumeration requires the Drush bridge.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name, e.g. 'article'
- `id` (string): Node UUID

**Optional:**
- `site` (string): Named site (omit for default)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
