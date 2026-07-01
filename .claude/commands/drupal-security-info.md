---
description: "Show the active security configuration for a site — what's allowed, what's blocked, what fields are redacted. Run this to understand the current access policy."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_security_info
---

Call the `mcp__drupal__drupal_security_info` MCP tool.

Show the active security configuration for a site — what's allowed, what's blocked, what fields are redacted. Run this to understand the current access policy.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
