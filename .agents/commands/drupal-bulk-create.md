---
description: "Create many entities of a single type + bundle in one call. Permission is checked once; each item is created independently, so the batch continues past individual failures (partial success). Returns per-item { index, success, id | error } and a summary { created, failed }. Paragraph items also return relationshipData with meta.target_revision_id for a later host attach. Writes default to unpublished/draft."
argument-hint: "<entityType> <bundle> <items> [site]"
---

Call the MCP tool `drupal_bulk_create`.

Create many entities of a single type + bundle in one call. Permission is checked once; each item is created independently, so the batch continues past individual failures (partial success). Returns per-item { index, success, id | error } and a summary { created, failed }. Paragraph items also return relationshipData with meta.target_revision_id for a later host attach. Writes default to unpublished/draft.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `entityType` (string): Entity type machine name, e.g. 'node', 'taxonomy_term'
- `bundle` (string): Bundle machine name, e.g. 'article'
- `items` (array (pass as JSON)): Entities to create. Each is { attributes?, relationships? }.

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
