---
description: "Scan published body content for embedded entities (media/entity embeds) and report usage by type, flagging embeds with a missing/malformed data-entity-uuid. Full target-existence verification is gated on a future server-tool."
argument-hint: "<type> [site] [sampleSize]"
---

Call the MCP tool `drupal_report_broken_embeds`.

Scan published body content for embedded entities (media/entity embeds) and report usage by type, flagging embeds with a missing/malformed data-entity-uuid. Full target-existence verification is gated on a future server-tool.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Content type machine name (required; see drupal_list_content_types)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `sampleSize` (number): Max nodes to scan

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
