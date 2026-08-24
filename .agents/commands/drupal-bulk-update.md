---
description: "Update many entities of a single type + bundle in one call. Permission is checked once; each item is updated independently, so the batch continues past individual failures (partial success). Each item requires an 'id' (UUID); items missing an id are reported as per-item failures. Published moderated targets without an explicit attributes.moderation_state default to moderation_state 'draft' (forward revision) so bulk edits do not mutate live default revisions. Returns per-item { index, success, id | error } and a summary { updated, failed }."
argument-hint: "<entityType> <bundle> <items> [site]"
---

Call the MCP tool `drupal_bulk_update`.

Update many entities of a single type + bundle in one call. Permission is checked once; each item is updated independently, so the batch continues past individual failures (partial success). Each item requires an 'id' (UUID); items missing an id are reported as per-item failures. Published moderated targets without an explicit attributes.moderation_state default to moderation_state 'draft' (forward revision) so bulk edits do not mutate live default revisions. Returns per-item { index, success, id | error } and a summary { updated, failed }.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `entityType` (string): Entity type machine name
- `bundle` (string): Bundle machine name
- `items` (array (pass as JSON)): Entities to update. Each is { id, attributes?, relationships? }.

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
