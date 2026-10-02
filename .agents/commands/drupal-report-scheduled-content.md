---
description: "Report content with Scheduler publish/unpublish dates set, split into pending (future) and overdue (past, action not run). Omit type to scan every node bundle in one call (one row per bundle in byContentType). A bundle is gated only when sampled nodes carry no publish_on/unpublish_on key at all; fields that exist but are empty report pending 0 / overdue 0. A bundle with no nodes reports zero counts with schedulerFields 'unknown'."
argument-hint: "[site] [type] [sampleSize]"
---

Call the MCP tool `drupal_report_scheduled_content`.

Report content with Scheduler publish/unpublish dates set, split into pending (future) and overdue (past, action not run). Omit type to scan every node bundle in one call (one row per bundle in byContentType). A bundle is gated only when sampled nodes carry no publish_on/unpublish_on key at all; fields that exist but are empty report pending 0 / overdue 0. A bundle with no nodes reports zero counts with schedulerFields 'unknown'.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type machine name. Omit to scan every node bundle.
- `sampleSize` (number): Max nodes to scan per content type

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
