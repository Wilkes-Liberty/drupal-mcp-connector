---
description: "Look up a Drupal user by their exact username."
argument-hint: "<name> [site]"
allowed-tools: mcp__drupal__drupal_get_user_by_name
---

Call the `mcp__drupal__drupal_get_user_by_name` MCP tool.

Look up a Drupal user by their exact username.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `name` (string): Drupal username (exact match)

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
