/**
 * Tool group: GraphQL.
 *
 * Raw GraphQL execution and schema introspection against a Drupal site. Require
 * the GraphQL Compose module (drupal.org/project/graphql_compose), which
 * exposes a read-only schema (no mutations); any mutation in a query is
 * additionally gated by the per-site "allowGraphqlMutations" security flag,
 * enforced by the middleware in index.js before the handler runs.
 *
 * Per-site config: set "graphqlEndpoint" to override "/graphql".
 * Auth reuses the same credentials as the JSON:API tools.
 */

import { getSiteConfig } from "../lib/config.js";
import { drupalGraphqlFetch } from "../lib/drupal-fetch.js";

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

/**
 * Execute a GraphQL query or mutation and normalize the response envelope.
 *
 * @param {object} args - { site?, query, variables?, operationName? }.
 * @returns {Promise<{data: object, warnings?: string[]}>} On a clean response,
 *   just `data`. When the server returns errors alongside partial `data`, the
 *   error messages are surfaced as `warnings` rather than thrown.
 * @throws {Error} If the response carries errors and no data at all.
 */
async function runGraphql({ site: siteName, query, variables = {}, operationName }) {
  const site = getSiteConfig(siteName);
  const json = await drupalGraphqlFetch(site, { query, variables, operationName });

  if (json.errors?.length) {
    const messages = json.errors.map((e) => e.message).join("; ");
    if (!json.data) throw new Error(`GraphQL errors: ${messages}`);
    // Partial result — return data AND surface errors as a warning
    return { data: json.data, warnings: json.errors.map((e) => e.message) };
  }

  return { data: json.data };
}

/**
 * Introspect the GraphQL schema, either in detail for one type or as an
 * overview. When `typeName` is given, returns that type's fields, args, and
 * input fields. Otherwise returns the root operation types plus all non
 * built-in, non-scalar types for readability.
 *
 * @param {object} args - { site?, typeName? }.
 * @returns {Promise<object>} A single __type descriptor, or a schema overview.
 * @throws {Error} If a requested typeName is not present in the schema, or the
 *   overview query returns errors.
 */
async function introspectGraphql({ site: siteName, typeName }) {
  const site = getSiteConfig(siteName);

  // If a specific type is requested, get detailed field info for it.
  if (typeName) {
    const query = `
      query IntrospectType($name: String!) {
        __type(name: $name) {
          name
          kind
          description
          fields(includeDeprecated: true) {
            name
            description
            isDeprecated
            deprecationReason
            type { name kind ofType { name kind ofType { name kind } } }
            args { name description type { name kind ofType { name kind } } }
          }
          inputFields {
            name
            description
            type { name kind ofType { name kind } }
          }
        }
      }
    `;
    const json = await drupalGraphqlFetch(site, { query, variables: { name: typeName } });
    if (!json.data?.__type) throw new Error(`Type '${typeName}' not found in schema.`);
    return json.data.__type;
  }

  // Otherwise return a high-level schema overview.
  const query = `
    {
      __schema {
        queryType  { name }
        mutationType { name }
        subscriptionType { name }
        types {
          name
          kind
          description
          fields { name type { name kind ofType { name kind } } }
        }
      }
    }
  `;
  const json = await drupalGraphqlFetch(site, { query });
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }

  const schema = json.data.__schema;
  // Filter out built-in introspection types (__*) and scalars for readability
  const types = schema.types.filter(
    (t) => !t.name.startsWith("__") && t.kind !== "SCALAR"
  );

  return {
    queryType:        schema.queryType?.name ?? null,
    mutationType:     schema.mutationType?.name ?? null,
    subscriptionType: schema.subscriptionType?.name ?? null,
    types,
  };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_graphql",
    description: `Execute a GraphQL query against a Drupal site.
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
  }`,
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        site:          { type: "string", description: "Named site (omit for default)" },
        query:         { type: "string", description: "GraphQL query or mutation string" },
        variables:     { type: "object", description: "Variables to pass with the query" },
        operationName: { type: "string", description: "Operation name (for multi-operation documents)" },
      },
    },
  },
  {
    name: "drupal_graphql_introspect",
    description: "Introspect the Drupal GraphQL schema. Omit typeName for a full schema overview; provide typeName to get detailed fields and args for a specific type.",
    inputSchema: {
      type: "object",
      properties: {
        site:     { type: "string" },
        typeName: { type: "string", description: "Name of a specific GraphQL type to inspect in detail (optional)" },
      },
    },
  },
];

export const handlers = {
  drupal_graphql:           runGraphql,
  drupal_graphql_introspect: introspectGraphql,
};
