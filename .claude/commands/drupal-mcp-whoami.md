---
description: "Report the agent's effective governance tier, security preset, OAuth scopes, and capabilities (read/write/delete/config/publish) for a site. No credentials, no backend call."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_mcp_whoami
---

Call the `mcp__drupal__drupal_mcp_whoami` MCP tool.

Report the agent's effective governance tier, security preset, OAuth scopes, and capabilities (read/write/delete/config/publish) for a site. No credentials, no backend call.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
