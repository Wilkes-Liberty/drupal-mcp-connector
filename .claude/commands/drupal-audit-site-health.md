---
description: "Composite site-health dashboard: runs a battery of content, link, and configuration audits and rolls them into one scored report with a letter grade. Each section degrades independently — gated/errored sections are recorded, not fatal. Read-only."
argument-hint: "[site] [type] [sampleSize] [sections]"
allowed-tools: mcp__drupal__drupal_audit_site_health
---

Call the `mcp__drupal__drupal_audit_site_health` MCP tool.

Composite site-health dashboard: runs a battery of content, link, and configuration audits and rolls them into one scored report with a letter grade. Each section degrades independently — gated/errored sections are recorded, not fatal. Read-only.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `type` (string): Primary content type for content/link sections (default: article)
- `sampleSize` (number): Per-section scan cap (kept small for a fast roll-up)
- `sections` (array (pass as JSON)): Subset of sections to run (default: all). Available: content_summary, stale_content, seo_audit, accessibility, duplicate_content, readability, pii_exposure, broken_links, redirect_health, alias_coverage, log_404, config_best_practices, module_audit, permission_audit

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
