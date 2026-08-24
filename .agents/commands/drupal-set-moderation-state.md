---
description: "Transition a content node to a moderation state (content_moderation), e.g. 'draft', 'needs_review', 'published', 'archived'. Governed write."
argument-hint: "<type> <id> <state> [site]"
---

Call the MCP tool `drupal_set_moderation_state`.

Transition a content node to a moderation state (content_moderation), e.g. 'draft', 'needs_review', 'published', 'archived'. Governed write.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Content type machine name
- `id` (string): Node UUID
- `state` (string): Target moderation state machine name

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
