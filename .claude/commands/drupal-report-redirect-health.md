---
description: "Audit the Redirect module table for structural problems: duplicate sources, self-redirects, and redirect chains/loops. Deterministic from the redirect entity list; gated when the 'redirect' resource isn't exposed."
argument-hint: "[site] [limit]"
allowed-tools: mcp__drupal__drupal_report_redirect_health
---

Call the `mcp__drupal__drupal_report_redirect_health` MCP tool.

Audit the Redirect module table for structural problems: duplicate sources, self-redirects, and redirect chains/loops. Deterministic from the redirect entity list; gated when the 'redirect' resource isn't exposed.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `limit` (number): Max redirects to scan

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
