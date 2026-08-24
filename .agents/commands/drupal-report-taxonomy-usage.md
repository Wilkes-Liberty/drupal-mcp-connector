---
description: "Count how many nodes use each term in a vocabulary. Identifies over-used, under-used, and orphaned terms."
argument-hint: "<vocabulary> [site] [contentType] [referenceField] [limit]"
---

Call the MCP tool `drupal_report_taxonomy_usage`.

Count how many nodes use each term in a vocabulary. Identifies over-used, under-used, and orphaned terms.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `vocabulary` (string): Vocabulary machine name, e.g. 'tags', 'category'

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `contentType` (string): Content type to count references from (default: article)
- `referenceField` (string): Field referencing the vocabulary (default: field_{vocabulary})
- `limit` (number)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
