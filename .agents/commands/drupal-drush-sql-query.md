---
description: "Run a single read-only SELECT through mcp_sentinel's governed command (`drush mcp-sentinel:sql-query`). Requires the site to set drushSsh.rawSql=\"governed\" AND the site's policy profile to set allow_raw_sql; both are off by default. The server refuses statements touching a denied entity type, a non-entity table, or a redacted field, and records every attempt in the tamper-evident audit log. Use the site-context or entity-schema tools for schema introspection."
argument-hint: "<query> [site]"
---

Call the MCP tool `drupal_drush_sql_query`.

Run a single read-only SELECT through mcp_sentinel's governed command (`drush mcp-sentinel:sql-query`). Requires the site to set drushSsh.rawSql="governed" AND the site's policy profile to set allow_raw_sql; both are off by default. The server refuses statements touching a denied entity type, a non-entity table, or a redacted field, and records every attempt in the tamper-evident audit log. Use the site-context or entity-schema tools for schema introspection.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `query` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
