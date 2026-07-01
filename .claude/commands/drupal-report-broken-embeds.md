---
description: "Scan published body content for embedded entities (media/entity embeds) and report usage by type, flagging embeds with a missing/malformed data-entity-uuid. Full target-existence verification is gated on a future server-tool."
argument-hint: "[site] [type] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_broken_embeds
---

Call the `mcp__drupal__drupal_report_broken_embeds` MCP tool.

Scan published body content for embedded entities (media/entity embeds) and report usage by type, flagging embeds with a missing/malformed data-entity-uuid. Full target-existence verification is gated on a future server-tool.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `sampleSize` (number): Max nodes to scan

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
