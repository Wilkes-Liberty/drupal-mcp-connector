---
description: "Find nodes with the most revision activity — useful for spotting churn or content that needs editorial process review. Requires Drupal 9.3+ JSON:API revisions."
argument-hint: "[site] [type] [limit]"
---

Call the MCP tool `drupal_report_revision_hotspots`.

Find nodes with the most revision activity — useful for spotting churn or content that needs editorial process review. Requires Drupal 9.3+ JSON:API revisions.

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Content type (default: article)
- `limit` (number)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
