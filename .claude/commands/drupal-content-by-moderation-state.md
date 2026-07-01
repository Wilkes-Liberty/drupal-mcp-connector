---
description: "List nodes of a content type currently in a given moderation state (e.g. what is in 'draft' or 'needs_review')."
argument-hint: "[site] <type> <state> [limit] [offset]"
allowed-tools: mcp__drupal__drupal_content_by_moderation_state
---

Call the `mcp__drupal__drupal_content_by_moderation_state` MCP tool.

List nodes of a content type currently in a given moderation state (e.g. what is in 'draft' or 'needs_review').

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name
- `state` (string): Moderation state machine name

**Optional:**
- `site` (string): omit for the default site
- `limit` (number)
- `offset` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
