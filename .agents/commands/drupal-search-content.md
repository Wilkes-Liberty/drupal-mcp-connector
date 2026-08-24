---
description: "Search nodes by title substring. Returns title, path alias, and body summary."
argument-hint: "<query> [site] [type] [status] [limit]"
---

Call the MCP tool `drupal_search_content`.

Search nodes by title substring. Returns title, path alias, and body summary.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `query` (string): Search term to match against node titles

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `type` (string): Limit to this content type (default: article)
- `status` (boolean (true/false)): Filter by publish status
- `limit` (number)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
