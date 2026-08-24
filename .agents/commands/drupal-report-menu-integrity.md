---
description: "Audit custom menu links (menu_link_content): disabled links, links with no usable target (route:<nojs>/empty placeholders), and external links. Structural; deep target-existence checks are not performed (JSON:API can't probe a target by internal id)."
argument-hint: "[site] [limit]"
---

Call the MCP tool `drupal_report_menu_integrity`.

Audit custom menu links (menu_link_content): disabled links, links with no usable target (route:<nojs>/empty placeholders), and external links. Structural; deep target-existence checks are not performed (JSON:API can't probe a target by internal id).

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `limit` (number): Max menu links to scan

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
