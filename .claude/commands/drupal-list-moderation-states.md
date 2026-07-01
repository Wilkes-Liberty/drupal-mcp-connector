---
description: "List the moderation states observed on a content type's content (best-effort; authoritative transitions require the Drush bridge)."
argument-hint: "<type> [site] [sample]"
allowed-tools: mcp__drupal__drupal_list_moderation_states
---

Call the `mcp__drupal__drupal_list_moderation_states` MCP tool.

List the moderation states observed on a content type's content (best-effort; authoritative transitions require the Drush bridge).

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name

**Optional:**
- `site` (string): omit for the default site
- `sample` (number): How many recent items to sample

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
