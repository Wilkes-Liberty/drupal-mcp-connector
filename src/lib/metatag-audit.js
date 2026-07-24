/**
 * Rendered meta-description resolution for the SEO audit.
 *
 * A Drupal site using the Metatag module computes a node's final tags at render
 * time from bundle *defaults* (often token fallbacks like `[node:summary]`) plus
 * any per-node override. That computed value is NOT resolved over JSON:API — the
 * `metatag` field there is a structural placeholder with empty attributes — so a
 * JSON:API-only audit cannot see whether a description is actually emitted, and
 * treating the placeholder as "present" silently reports 0 missing on every node
 * (see issue #120).
 *
 * The only source that reflects what the frontend renders is GraphQL Compose's
 * normalized `metatag` field (exposed by graphql_compose_metatags). This module
 * fetches it via `route(path:)` — the same entry point the frontend uses — with
 * a query that needs no schema introspection (which many sites disable).
 */

import { drupalGraphqlFetch } from "./drupal-fetch.js";

// Node paths are batched into aliased `route()` selections per request. Kept
// modest so a single document stays small and one bad path can't sink a large
// batch (each alias resolves independently).
const CHUNK = 25;

// `metatag` lives on NodeInterface, so one selection covers every node bundle
// without knowing per-bundle GraphQL type names (unavailable when introspection
// is disabled). `route` resolves to a union; the fragment matches the internal
// (entity-backed) case and is simply skipped for redirects/external routes.
const ROUTE_META_FRAGMENT = `fragment MetaOnRoute on RouteInternal {
  entity {
    ... on NodeInterface {
      metatag {
        __typename
        ... on MetaTagValue { attributes { name content } }
      }
    }
  }
}`;

/**
 * Pull the rendered meta description out of a GraphQL `metatag` array.
 *
 * @param {unknown} metatag The node's normalized `metatag` field value.
 * @returns {string} The trimmed description content, or "" when absent/empty.
 */
export function metaDescriptionFromMetatag(metatag) {
  if (!Array.isArray(metatag)) return "";
  for (const tag of metatag) {
    if (
      tag &&
      tag.__typename === "MetaTagValue" &&
      tag.attributes &&
      tag.attributes.name === "description"
    ) {
      return typeof tag.attributes.content === "string" ? tag.attributes.content.trim() : "";
    }
  }
  return "";
}

/**
 * Resolve rendered meta descriptions for a set of published nodes via GraphQL.
 *
 * @param {object} site Resolved site config (for drupalGraphqlFetch).
 * @param {Array<{id: string, url?: ?string}>} entities Nodes to resolve; each
 *   must carry its path alias in `url` to be resolvable.
 * @returns {Promise<{source: "graphql"|"unavailable", reason?: string,
 *   byId: Map<string, {description: string}>}>}
 *   - source "graphql": `byId` maps entity id → { description } for every node
 *     whose route resolved to an entity. Nodes with no resolvable route are
 *     omitted (unknown), never assumed missing.
 *   - source "unavailable": GraphQL, `route`, or the `metatag` field is not
 *     reachable. The caller MUST NOT treat this as "0 missing".
 */
export async function fetchRenderedMetaDescriptions(site, entities) {
  const byId = new Map();
  const withPath = entities
    .map((e) => ({ id: e.id, path: typeof e.url === "string" ? e.url : null }))
    .filter((e) => e.path && e.path.startsWith("/"));

  if (withPath.length === 0) {
    return { source: "unavailable", reason: "no node path aliases available to resolve", byId };
  }

  for (let i = 0; i < withPath.length; i += CHUNK) {
    const chunk = withPath.slice(i, i + CHUNK);
    const varDecls = chunk.map((_, j) => `$p${j}: String!`).join(", ");
    const selections = chunk.map((_, j) => `  n${j}: route(path: $p${j}) { ...MetaOnRoute }`).join("\n");
    const query = `query MetaAudit(${varDecls}) {\n${selections}\n}\n\n${ROUTE_META_FRAGMENT}`;
    const variables = Object.fromEntries(chunk.map((e, j) => [`p${j}`, e.path]));

    let json;
    try {
      json = await drupalGraphqlFetch(site, { query, variables });
    } catch (err) {
      // Endpoint unreachable / not configured / auth failure.
      return { source: "unavailable", reason: `GraphQL request failed: ${err.message}`, byId };
    }

    if (Array.isArray(json.errors) && json.errors.length > 0) {
      // A schema-level error (no `route`, no `metatag` field, graphql_compose_metatags
      // absent) means we cannot determine descriptions — fail closed to
      // "unavailable" rather than reporting every node as missing.
      return { source: "unavailable", reason: json.errors[0]?.message ?? "GraphQL error", byId };
    }

    const data = json.data || {};
    chunk.forEach((e, j) => {
      const route = data[`n${j}`];
      const entity = route && route.entity;
      if (!entity) return; // route did not resolve to a node; leave unknown
      byId.set(e.id, { description: metaDescriptionFromMetatag(entity.metatag) });
    });
  }

  return { source: "graphql", byId };
}
