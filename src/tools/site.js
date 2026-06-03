/**
 * Tool group: Site.
 *
 * Site-level discovery: base URL and available resource/query types, content
 * type listing, and enumeration of configured named sites. Backend-agnostic
 * (works for both JSON:API and GraphQL backends).
 */

import { getSiteConfig, listSiteNames } from "../lib/config.js";
import { resolveBackend } from "../lib/backends/index.js";

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

/**
 * Report a site's base URL and the resource/query types its backend exposes.
 *
 * @param {object} args - { site? }.
 * @returns {Promise<{site: string, baseUrl: string, resourceTypes: object[]}>}
 */
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

/**
 * List the content types defined on a site.
 * @param {object} args - { site? }.
 * @returns {Promise<object[]>} Content type descriptors (machine name + label).
 */
async function listContentTypes({ site: siteName }) {
  const site = getSiteConfig(siteName);
  const backend = await resolveBackend(site);
  return backend.listContentTypes();
}

/**
 * List all named sites from config.json. No backend call and no credentials.
 * @returns {Promise<{sites: string[]}>}
 */
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
