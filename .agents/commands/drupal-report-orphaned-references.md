---
description: "Find entities whose entity-reference fields point at targets that no longer exist (orphaned references). Best-effort: samples entities and probes each distinct referenced target via JSON:API. A 404 (or unaddressable ref) is an orphan; 401/403 and connector policy denials are counted as unverifiable, not missing. uid/revision_uid are skipped when the policy denies user. Flags 'approximate' when sampling-bounded."
argument-hint: "[site] [type] [sampleSize]"
---

Call the MCP tool `drupal_report_orphaned_references`.

Find entities whose entity-reference fields point at targets that no longer exist (orphaned references). Best-effort: samples entities and probes each distinct referenced target via JSON:API. A 404 (or unaddressable ref) is an orphan; 401/403 and connector policy denials are counted as unverifiable, not missing. uid/revision_uid are skipped when the policy denies user. Flags 'approximate' when sampling-bounded.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type machine name to scan (default: article)
- `sampleSize` (number): Max entities to scan for broken references

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
