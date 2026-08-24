---
description: "Introspect the Drupal GraphQL schema. Omit typeName for a full schema overview; provide typeName to get detailed fields and args for a specific type. Requires security.allowGraphql (off outside the development preset by default)."
argument-hint: "[site] [typeName]"
---

Call the MCP tool `drupal_graphql_introspect`.

Introspect the Drupal GraphQL schema. Omit typeName for a full schema overview; provide typeName to get detailed fields and args for a specific type. Requires security.allowGraphql (off outside the development preset by default).

Parse the arguments supplied with this command into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `typeName` (string): Name of a specific GraphQL type to inspect in detail (optional)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
