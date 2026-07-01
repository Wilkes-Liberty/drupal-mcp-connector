---
description: "Search nodes by title substring. Returns title, path alias, and body summary."
argument-hint: "<query> [site] [type] [status] [limit]"
allowed-tools: mcp__drupal__drupal_search_content
---

Call the `mcp__drupal__drupal_search_content` MCP tool.

Search nodes by title substring. Returns title, path alias, and body summary.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `query` (string): Search term to match against node titles

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Limit to this content type (default: article)
- `status` (boolean (true/false)): Filter by publish status
- `limit` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
