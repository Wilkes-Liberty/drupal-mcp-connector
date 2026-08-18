---
description: "Report each configured site's source-governance condition. Always probes GET /drupal-mcp/readiness (even when this client does not require governance) and surfaces the server's reason verbatim. Never reports ok:true unless that check ran. Callable even while governed paths are denied — this is the diagnostic for that denial."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_governance_status
---

Call the `mcp__drupal__drupal_governance_status` MCP tool.

Report each configured site's source-governance condition. Always probes GET /drupal-mcp/readiness (even when this client does not require governance) and surfaces the server's reason verbatim. Never reports ok:true unless that check ran. Callable even while governed paths are denied — this is the diagnostic for that denial.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
