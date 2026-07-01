---
description: "Block or unblock a Drupal user account without deleting it."
argument-hint: "<id> [site] [block]"
allowed-tools: mcp__drupal__drupal_block_user
---

Call the `mcp__drupal__drupal_block_user` MCP tool.

Block or unblock a Drupal user account without deleting it.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `id` (string): User UUID

**Optional:**
- `site` (string): omit for the default site
- `block` (boolean (true/false)): true = block, false = unblock

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
