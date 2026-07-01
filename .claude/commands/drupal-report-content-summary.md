---
description: "High-level content inventory: total node counts by type and status (published/unpublished). Good first step for any site audit."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_report_content_summary
---

Call the `mcp__drupal__drupal_report_content_summary` MCP tool.

High-level content inventory: total node counts by type and status (published/unpublished). Good first step for any site audit.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
