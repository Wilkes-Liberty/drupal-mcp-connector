---
description: "Create a new taxonomy term in a vocabulary."
argument-hint: "<vocabulary> <name> [site] [description] [weight] [parentId]"
---

Call the MCP tool `drupal_create_taxonomy_term`.

Create a new taxonomy term in a vocabulary.

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `vocabulary` (string)
- `name` (string)

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `description` (string)
- `weight` (number)
- `parentId` (string): UUID of parent term (for hierarchical vocabularies)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
