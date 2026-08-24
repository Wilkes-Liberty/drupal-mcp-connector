---
description: "Find entities of a content type where a given field is empty (e.g. a missing meta description, image, or summary). Works for scalar fields and entity-reference fields. Sampling-bounded — flags 'approximate' when the scan is capped."
argument-hint: "<field> [site] [type] [sampleSize]"
---

Call the MCP tool `drupal_report_missing_field`.

Find entities of a content type where a given field is empty (e.g. a missing meta description, image, or summary). Works for scalar fields and entity-reference fields. Sampling-bounded — flags 'approximate' when the scan is capped.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `field` (string): Field machine name to check for emptiness, e.g. 'field_meta_description', 'field_image'

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type machine name (default: article)
- `sampleSize` (number): Max entities to scan

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
