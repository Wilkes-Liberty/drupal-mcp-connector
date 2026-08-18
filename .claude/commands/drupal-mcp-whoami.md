---
description: "Report the agent's effective governance tier, security preset, OAuth scopes, and capabilities (read/write/delete/config/publish) for a site. No credentials, no backend call."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_mcp_whoami
---

Call the `mcp__drupal__drupal_mcp_whoami` MCP tool.

Report the agent's effective governance tier, security preset, OAuth scopes, and capabilities (read/write/delete/config/publish) for a site. No credentials, no backend call.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
