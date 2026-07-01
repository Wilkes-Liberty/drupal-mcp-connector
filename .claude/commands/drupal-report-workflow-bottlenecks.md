---
description: "Find content stuck in a non-published moderation state (draft/needs_review) beyond N days — editorial bottlenecks. Reads moderation_state; gated when content_moderation isn't exposed."
argument-hint: "[site] [type] [days] [states] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_workflow_bottlenecks
---

Call the `mcp__drupal__drupal_report_workflow_bottlenecks` MCP tool.

Find content stuck in a non-published moderation state (draft/needs_review) beyond N days — editorial bottlenecks. Reads moderation_state; gated when content_moderation isn't exposed.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type (default: article)
- `days` (number): Days-in-state threshold
- `states` (array (pass as JSON)): Moderation states to treat as bottlenecks
- `sampleSize` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
