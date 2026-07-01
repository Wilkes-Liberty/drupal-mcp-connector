---
description: "Find entities whose entity-reference fields point at targets that no longer exist (orphaned references). Best-effort: samples entities and probes each distinct referenced target via JSON:API. Flags 'approximate' when sampling-bounded."
argument-hint: "[site] [type] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_orphaned_references
---

Call the `mcp__drupal__drupal_report_orphaned_references` MCP tool.

Find entities whose entity-reference fields point at targets that no longer exist (orphaned references). Best-effort: samples entities and probes each distinct referenced target via JSON:API. Flags 'approximate' when sampling-bounded.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type machine name to scan (default: article)
- `sampleSize` (number): Max entities to scan for broken references

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
