---
description: "Find entities of a content type where a given field is empty (e.g. a missing meta description, image, or summary). Works for scalar fields and entity-reference fields. Sampling-bounded — flags 'approximate' when the scan is capped."
argument-hint: "<field> [site] [type] [sampleSize]"
allowed-tools: mcp__drupal__drupal_report_missing_field
---

Call the `mcp__drupal__drupal_report_missing_field` MCP tool.

Find entities of a content type where a given field is empty (e.g. a missing meta description, image, or summary). Works for scalar fields and entity-reference fields. Sampling-bounded — flags 'approximate' when the scan is capped.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `field` (string): Field machine name to check for emptiness, e.g. 'field_meta_description', 'field_image'

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Content type machine name (default: article)
- `sampleSize` (number): Max entities to scan

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
