---
description: "Execute a GraphQL query against a Drupal site. Requires the GraphQL Compose module (drupal.org/project/graphql_compose), which exposes a read-only schema; mutations are gated by \"allowGraphqlMutations\". Use drupal_graphql_introspect first to discover available types and fields. Example query: query GetArticle($id: String!) { nodeById(id: $id) { title ... on NodeArticle { body { value } } } } Example mutation (only if your GraphQL Compose schema enables mutations): mutation CreateArticle($title: String!, $body: String!) { createNodeArticle(data: { title: $title, body: { value: $body, format: \"full_html\" } }) { entity { title uuid } errors { message } } }"
argument-hint: "<query> [site] [variables] [operationName]"
allowed-tools: mcp__drupal__drupal_graphql
---

Call the `mcp__drupal__drupal_graphql` MCP tool.

Execute a GraphQL query against a Drupal site.
Requires the GraphQL Compose module (drupal.org/project/graphql_compose), which
exposes a read-only schema; mutations are gated by "allowGraphqlMutations".
Use drupal_graphql_introspect first to discover available types and fields.

Example query:
  query GetArticle($id: String!) {
    nodeById(id: $id) {
      title
      ... on NodeArticle { body { value } }
    }
  }

Example mutation (only if your GraphQL Compose schema enables mutations):
  mutation CreateArticle($title: String!, $body: String!) {
    createNodeArticle(data: { title: $title, body: { value: $body, format: "full_html" } }) {
      entity { title uuid }
      errors { message }
    }
  }

Parse the request in `$ARGUMENTS` into this tool's parameters:

**Required:**
- `query` (string): GraphQL query or mutation string

**Optional:**
- `site` (string): Named site (omit for default)
- `variables` (object (pass as JSON)): Variables to pass with the query
- `operationName` (string): Operation name (for multi-operation documents)

If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
