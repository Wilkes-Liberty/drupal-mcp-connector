---
description: "Execute a GraphQL query against a Drupal site. Requires the GraphQL Compose module (drupal.org/project/graphql_compose), which exposes a read-only schema. GraphQL is off unless security.allowGraphql is true (development preset only by default) because raw results bypass entity allowlists and field redaction. Mutations also require allowGraphqlMutations. Use drupal_graphql_introspect first to discover available types and fields. Example query: query GetArticle($id: String!) { nodeById(id: $id) { title ... on NodeArticle { body { value } } } } Example mutation (only if your GraphQL Compose schema enables mutations): mutation CreateArticle($title: String!, $body: String!) { createNodeArticle(data: { title: $title, body: { value: $body, format: \"full_html\" } }) { entity { title uuid } errors { message } } }"
argument-hint: "<query> [site] [variables] [operationName]"
---

Call the MCP tool `drupal_graphql`.

Execute a GraphQL query against a Drupal site.
Requires the GraphQL Compose module (drupal.org/project/graphql_compose), which
exposes a read-only schema. GraphQL is off unless security.allowGraphql is true
(development preset only by default) because raw results bypass entity allowlists
and field redaction. Mutations also require allowGraphqlMutations.
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

Parse the arguments supplied with this command into this tool's parameters:

**Required:**
- `query` (string): GraphQL query or mutation string

**Optional:**
- `site` (string): Named site from connector config. Omit only on reads: multi-site configs fall back to defaultSite (often local/dev, not production). Writes require an explicit site when more than one site is configured. Every response includes `_target` { name, baseUrl, source } (`hint` when you passed site, `default` when you did not).
- `variables` (object (pass as JSON)): Variables to pass with the query
- `operationName` (string): Operation name (for multi-operation documents)

If a required parameter is missing, ask before calling — do not invent values. Coerce each value to its JSON type (booleans → true/false, numbers → numeric, object/array → parse JSON), then make the single tool call and summarize the result.
