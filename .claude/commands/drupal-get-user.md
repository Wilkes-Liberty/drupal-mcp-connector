---
description: "Fetch a single Drupal user account by UUID, including their assigned roles."
argument-hint: "[site] <id>"
allowed-tools: mcp__drupal__drupal_get_user
---

Call the `mcp__drupal__drupal_get_user` MCP tool.

Fetch a single Drupal user account by UUID, including their assigned roles.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `id` (string): User UUID

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
