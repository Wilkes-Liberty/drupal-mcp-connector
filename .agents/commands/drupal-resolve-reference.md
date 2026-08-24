---
description: "Resolve a human name or title to a Drupal entity UUID. Use this before creating or updating an entity reference when you only know the label (e.g. a taxonomy term name, a user name, or a node title) and not its UUID. Read-only: returns the best match { id, title } plus any ambiguous candidates. Filters on 'title' for nodes and 'name' for taxonomy_term / user."
argument-hint: "<entityType> <bundle> <name> [site] [limit]"
---

Call the MCP tool `drupal_resolve_reference`.

Resolve a human name or title to a Drupal entity UUID. Use this before creating or updating an entity reference when you only know the label (e.g. a taxonomy term name, a user name, or a node title) and not its UUID. Read-only: returns the best match { id, title } plus any ambiguous candidates. Filters on 'title' for nodes and 'name' for taxonomy_term / user.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `entityType` (string): Entity type machine name, e.g. 'node', 'taxonomy_term', 'user'
- `bundle` (string): Bundle machine name, e.g. 'article', 'tags', 'user'
- `name` (string): Human name/title to resolve (matched as a substring)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `limit` (number): Maximum candidates to consider

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
