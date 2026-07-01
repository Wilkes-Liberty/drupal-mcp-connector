---
description: "Find published pages with no inbound internal links from other sampled pages — content islands. Best-effort over the sampled set."
argument-hint: "[site] [type] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_orphan_pages
---

Call the `mcp__drupal__drupal_report_orphan_pages` MCP tool.

Find published pages with no inbound internal links from other sampled pages — content islands. Best-effort over the sampled set.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `sampleSize` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
