---
description: "Introspect the Drupal GraphQL schema. Omit typeName for a full schema overview; provide typeName to get detailed fields and args for a specific type."
argument-hint: "[site] [typeName]"
allowed-tools: mcp__drupal__drupal_graphql_introspect
---

Call the `mcp__drupal__drupal_graphql_introspect` MCP tool.

Introspect the Drupal GraphQL schema. Omit typeName for a full schema overview; provide typeName to get detailed fields and args for a specific type.

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Optional:**
- `site` (string): omit for the default site
- `typeName` (string): Name of a specific GraphQL type to inspect in detail (optional)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
