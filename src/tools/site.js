/**
 * Site-level tools: content type discovery, resource listing, site info.
 */

import { getSiteConfig, listSiteNames } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async function getSiteInfo({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  const info = await backend.introspect();
  return {
    site: site._name,
    baseUrl: site.baseUrl,
    resourceTypes: info.resourceTypes ?? [],
  };
}

async function listContentTypes({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  return backend.listContentTypes();
}

async function listConfiguredSites() {
  return { sites: listSiteNames() };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const definitions = [
  {
    name: "drupal_site_info",
    description: "Get the base URL and the list of available resource/query types for a configured site (works for JSON:API and GraphQL backends).",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
    },
  },
  {
    name: "drupal_list_content_types",
    description: "List all content types defined on this Drupal site with their machine names and descriptions.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
    },
  },
  {
    name: "drupal_list_sites",
    description: "List all named Drupal sites configured in config.json. Useful for multi-site setups.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export const handlers = {
  drupal_site_info:          getSiteInfo,
  drupal_list_content_types: listContentTypes,
  drupal_list_sites:         listConfiguredSites,
};
