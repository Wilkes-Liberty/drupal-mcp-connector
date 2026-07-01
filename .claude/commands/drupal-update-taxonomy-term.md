---
description: "Update an existing taxonomy term's name, description, or weight."
argument-hint: "<vocabulary> <id> [site] [name] [description] [weight]"
allowed-tools: mcp__drupal__drupal_update_taxonomy_term
---

Call the `mcp__drupal__drupal_update_taxonomy_term` MCP tool.

Update an existing taxonomy term's name, description, or weight.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `vocabulary` (string)
- `id` (string)

**Optional:**
- `site` (string): omit for the default site
- `name` (string)
- `description` (string)
- `weight` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
