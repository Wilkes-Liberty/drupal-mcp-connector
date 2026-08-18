---
description: "Introspect the Drupal GraphQL schema. Omit typeName for a full schema overview; provide typeName to get detailed fields and args for a specific type. Requires security.allowGraphql (off outside the development preset by default)."
argument-hint: "[site] [typeName]"
allowed-tools: mcp__drupal__drupal_graphql_introspect
---

Call the `mcp__drupal__drupal_graphql_introspect` MCP tool.

Introspect the Drupal GraphQL schema. Omit typeName for a full schema overview; provide typeName to get detailed fields and args for a specific type. Requires security.allowGraphql (off outside the development preset by default).

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `typeName` (string): Name of a specific GraphQL type to inspect in detail (optional)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
