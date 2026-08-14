---
description: "Report each configured site's source-governance condition: whether governance is required, whether the source contract verifies, and the failed condition when it does not. Callable even while governed paths are denied — this is the diagnostic for that denial."
argument-hint: "[site]"
allowed-tools: mcp__drupal__drupal_governance_status
---

Call the `mcp__drupal__drupal_governance_status` MCP tool.

Report each configured site's source-governance condition: whether governance is required, whether the source contract verifies, and the failed condition when it does not. Callable even while governed paths are denied — this is the diagnostic for that denial.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
