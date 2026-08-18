---
description: "List nodes of a content type currently in a given moderation state (e.g. what is in 'draft' or 'needs_review'). Stock JSON:API cannot filter the computed moderation_state field; when the site rejects that filter the tool samples recent nodes client-side and marks the result approximate, instead of returning Drupal's 500."
argument-hint: "<type> <state> [site] [limit] [offset]"
allowed-tools: mcp__drupal__drupal_content_by_moderation_state
---

Call the `mcp__drupal__drupal_content_by_moderation_state` MCP tool.

List nodes of a content type currently in a given moderation state (e.g. what is in 'draft' or 'needs_review'). Stock JSON:API cannot filter the computed moderation_state field; when the site rejects that filter the tool samples recent nodes client-side and marks the result approximate, instead of returning Drupal's 500.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `type` (string): Content type machine name
- `state` (string): Moderation state machine name

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `limit` (number)
- `offset` (number)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
