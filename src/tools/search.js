/**
 * Tool group: content search.
 *
 * Search API / Solr does not expose a JSON:API surface by default, so this tool
 * provides a best-effort search: a JSON:API title/body CONTAINS match over a
 * content type. Results are flagged mode:"fallback" and the response notes that
 * true relevance ranking requires a Search API endpoint (or the Drush bridge).
 * Read-only and redacted per the site policy.
 */

import { getSiteConfig } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";
import { resolveSecurityConfig, assertReadAllowed, redactCanonicalEntity } from "../lib/security.js";

/**
 * Search nodes of a type by a query string (title CONTAINS, best-effort).
 * @param {object} args - { site?, query, type?, limit? }.
 * @returns {Promise<{query, mode, note, results}>}
 */
async function search({ site: siteName, query, type = "article", limit = 10 }) {
  if (!query || !String(query).trim()) throw new Error("A non-empty 'query' is required.");
  const site = getSiteConfig(siteName);
  const sec = resolveSecurityConfig(site);
  assertReadAllowed(sec, "node", type);
  const backend = await resolveBackend(site);
  const res = await backend.listEntities({
    entityType: "node", bundle: type,
    filters: [{ field: "title", op: "contains", value: query }],
    sort: [{ field: "changed", dir: "desc" }],
    page: { limit },
  });
  const results = res.entities.map((e) => redactCanonicalEntity(e, sec, "node"));
  return {
    query,
    type,
    mode: "fallback",
    note: "JSON:API title CONTAINS match. Relevance-ranked full-text search requires a Search API/Solr endpoint or the Drush bridge.",
    results,
  };
}

export const definitions = [
  {
    name: "drupal_search",
    description: "Search content by a query string. Best-effort title match over a content type (mode:'fallback'); relevance-ranked search requires a Search API/Solr endpoint.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        site:  { type: "string" },
        query: { type: "string", description: "Search term" },
        type:  { type: "string", description: "Content type machine name (default: article)" },
        limit: { type: "number", default: 10 },
      },
    },
  },
];

export const handlers = {
  drupal_search: search,
};
