---
description: "Run a read-only SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN only) via Drush. Write queries are blocked by the security layer."
argument-hint: "<query> [site]"
allowed-tools: mcp__drupal__drupal_drush_sql_query
---

Call the `mcp__drupal__drupal_drush_sql_query` MCP tool.

Run a read-only SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN only) via Drush. Write queries are blocked by the security layer.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `query` (string)

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
