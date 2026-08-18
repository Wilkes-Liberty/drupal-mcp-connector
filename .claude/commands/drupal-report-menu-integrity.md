---
description: "Audit custom menu links (menu_link_content): disabled links, links with no usable target (route:<nojs>/empty placeholders), and external links. Structural; deep target-existence checks are not performed (JSON:API can't probe a target by internal id)."
argument-hint: "[site] [limit]"
allowed-tools: mcp__drupal__drupal_report_menu_integrity
---

Call the `mcp__drupal__drupal_report_menu_integrity` MCP tool.

Audit custom menu links (menu_link_content): disabled links, links with no usable target (route:<nojs>/empty placeholders), and external links. Structural; deep target-existence checks are not performed (JSON:API can't probe a target by internal id).

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `limit` (number): Max menu links to scan

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
