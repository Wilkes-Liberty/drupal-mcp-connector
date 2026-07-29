---
description: "Run a single read-only SELECT through mcp_sentinel's governed command (`drush mcp-sentinel:sql-query`). Requires the site to set drushSsh.rawSql=\"governed\" AND the site's policy profile to set allow_raw_sql; both are off by default. The server refuses statements touching a denied entity type, a non-entity table, or a redacted field, and records every attempt in the tamper-evident audit log. Use the site-context or entity-schema tools for schema introspection."
argument-hint: "<query> [site]"
allowed-tools: mcp__drupal__drupal_drush_sql_query
---

Call the `mcp__drupal__drupal_drush_sql_query` MCP tool.

Run a single read-only SELECT through mcp_sentinel's governed command (`drush mcp-sentinel:sql-query`). Requires the site to set drushSsh.rawSql="governed" AND the site's policy profile to set allow_raw_sql; both are off by default. The server refuses statements touching a denied entity type, a non-entity table, or a redacted field, and records every attempt in the tamper-evident audit log. Use the site-context or entity-schema tools for schema introspection.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `query` (string)

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
