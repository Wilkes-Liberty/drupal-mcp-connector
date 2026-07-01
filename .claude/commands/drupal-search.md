---
description: "Search content by a query string. Best-effort title match over a content type (mode:'fallback'); relevance-ranked search requires a Search API/Solr endpoint."
argument-hint: "[site] <query> [type] [limit]"
allowed-tools: mcp__drupal__drupal_search
---

Call the `mcp__drupal__drupal_search` MCP tool.

Search content by a query string. Best-effort title match over a content type (mode:'fallback'); relevance-ranked search requires a Search API/Solr endpoint.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `query` (string): Search term

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type machine name (default: article)
- `limit` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
