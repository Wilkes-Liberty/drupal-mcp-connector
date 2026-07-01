---
description: "Create a new taxonomy term in a vocabulary."
argument-hint: "[site] <vocabulary> <name> [description] [weight] [parentId]"
allowed-tools: mcp__drupal__drupal_create_taxonomy_term
---

Call the `mcp__drupal__drupal_create_taxonomy_term` MCP tool.

Create a new taxonomy term in a vocabulary.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `vocabulary` (string)
- `name` (string)

**Optional:**
- `site` (string): omit for the default site
- `description` (string)
- `weight` (number)
- `parentId` (string): UUID of parent term (for hierarchical vocabularies)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
