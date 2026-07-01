---
description: "Lint key configuration for production-readiness and security: on-screen error display, CSS/JS aggregation, anonymous page cache, open user registration, missing 404/403 pages, and insecure file uploads. Severity-ranked. Requires config-read access and the server-tool bridge."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_audit_config_best_practices
---

Call the `mcp__drupal__drupal_audit_config_best_practices` MCP tool.

Lint key configuration for production-readiness and security: on-screen error display, CSS/JS aggregation, anonymous page cache, open user registration, missing 404/403 pages, and insecure file uploads. Severity-ranked. Requires config-read access and the server-tool bridge.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
