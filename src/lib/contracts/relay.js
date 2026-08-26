/**
 * Tenant-relay contract (#181).
 *
 * Resolves the authoritative target for a principal. Caller-supplied site,
 * tenant, environment, or target fields are hints. They never become
 * authority. Vendor tunnel implementations stay outside this contract.
 */

import { resolveAuthoritativeTarget } from "../principal.js";
import { ContractError, REASON } from "./decisions.js";

/**
 * @typedef {Object} TenantRelay
 * @property {(identity: object|null, hints?: object) => {site: object, source: string, name: string}} resolve
 */

/**
 * Local, vendor-neutral relay over configured sites.
 *
 * @param {object} params
 * @param {Array<object>} params.sites
 * @param {object|null} [params.grants]
 * @param {string} [params.defaultSite]
 * @returns {TenantRelay}
 */
export function createLocalRelay({ sites, grants = null, defaultSite } = {}) {
  const catalog = Array.isArray(sites) ? sites : [];

  return Object.freeze({
    /**
     * @param {object|null} identity
     * @param {object} [hints]
     * @returns {{site: object, source: string, name: string}}
     */
    resolve(identity, hints = {}) {
      if (!identity) {
        const hintName = firstHint(hints);
        if (hintName) {
          const site = catalog.find((entry) => entry._name === hintName);
          if (!site) {
            throw new ContractError(
              "Caller hint is not an authoritative target.",
              REASON.TENANT_ESCAPE,
            );
          }
          return { site, source: "hint", name: site._name };
        }
        const fallback = catalog.find((entry) => entry._name === defaultSite) || catalog[0];
        if (!fallback) {
          throw new ContractError("No target configured.", REASON.TENANT_ESCAPE);
        }
        return { site: fallback, source: "default", name: fallback._name };
      }

      try {
        return resolveAuthoritativeTarget(hints, identity, catalog, {
          grants,
          defaultSite,
        });
      } catch (err) {
        throw new ContractError(
          err instanceof Error ? err.message : "Tenant escape.",
          REASON.TENANT_ESCAPE,
        );
      }
    },
  });
}

/**
 * @param {object} hints
 * @returns {string|undefined}
 */
function firstHint(hints) {
  for (const key of ["site", "target", "environment", "tenant"]) {
    const value = new Map(Object.entries(hints ?? {})).get(key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
