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
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `name` (string)
- `description` (string)
- `weight` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
