---
description: "Get the base URL and the list of available resource/query types for a configured site (works for JSON:API and GraphQL backends)."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_site_info
---

Call the `mcp__drupal__drupal_site_info` MCP tool.

Get the base URL and the list of available resource/query types for a configured site (works for JSON:API and GraphQL backends).

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
