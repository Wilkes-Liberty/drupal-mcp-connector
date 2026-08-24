---
description: "List the moderation states observed on a content type's content (best-effort; authoritative transitions require the Drush bridge)."
argument-hint: "<type> [site] [sample]"
---

Call the MCP tool `drupal_list_moderation_states`.

List the moderation states observed on a content type's content (best-effort; authoritative transitions require the Drush bridge).

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `type` (string): Content type machine name

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `sample` (number): How many recent items to sample

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
