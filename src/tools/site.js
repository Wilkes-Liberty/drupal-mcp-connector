/**
 * Tool group: Site.
 *
 * Site-level discovery: base URL and available resource/query types, content
 * type listing, and enumeration of configured named sites. Backend-agnostic
 * (works for both JSON:API and GraphQL backends).
 */

import { getSiteConfig, listSiteNames } from "../lib/config.js";
import { governanceStatus } from "../lib/governance.js";
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

/**
 * Per-site source-governance condition (#176). The one governed-path
 * diagnostic that stays callable while governance is failing, so an operator
 * can see WHICH required condition failed. Never includes credentials.
 *
 * @param {object} args - { site? } (a named site narrows the report).
 * @returns {Promise<{sites: object[]}>} required/ok/reason per site.
 */
async function getGovernanceStatus({ site: siteName } = {}) {
  const names = siteName ? [siteName] : listSiteNames();
  const resolved = [];
  const unresolved = [];
  for (const name of names) {
    try {
      resolved.push(getSiteConfig(name));
    } catch (error) {
      unresolved.push({
        site: name,
        required: null,
        ok: false,
        reason: "credential_unresolved",
        detail: error instanceof Error ? error.message : "site could not be resolved",
        checkedAt: null,
      });
    }
  }
  return { sites: [...unresolved, ...(await governanceStatus(resolved))] };
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
    name: "drupal_governance_status",
    description: "Report each configured site's source-governance condition: whether governance is required, whether the source contract verifies, and the failed condition when it does not. Callable even while governed paths are denied — this is the diagnostic for that denial.",
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

export { getGovernanceStatus };

export const handlers = {
  drupal_site_info:          getSiteInfo,
  drupal_list_content_types: listContentTypes,
  drupal_list_sites:         listConfiguredSites,
  drupal_governance_status:  getGovernanceStatus,
};
