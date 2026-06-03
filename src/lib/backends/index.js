/**
 * Backend resolution and registry.
 *
 * Single responsibility: choose the concrete backend adapter for a site —
 * honoring an explicit `api` config first, otherwise running a one-time
 * capability probe — and cache the verdict per site so resolution happens
 * once. This is the only module that knows the protocol-name -> adapter-class
 * mapping.
 */

import { drupalFetch } from "../drupal-fetch.js";
import { drupalGraphqlFetch } from "../drupal-fetch.js";
import { JsonApiBackend } from "./jsonapi.js";
import { GraphqlBackend } from "./graphql.js";
import { BackendResolutionError } from "./errors.js";

// Protocol name -> adapter class. Probe order follows insertion order.
const REGISTRY = new Map([
  ["jsonapi", JsonApiBackend],
  ["graphql", GraphqlBackend],
]);

// Per-site resolved-backend cache, keyed by site._name.
const cache = new Map();

/**
 * Test helper: clear the per-site backend cache.
 * @returns {void}
 */
export function _clearBackendCache() {
  cache.clear();
}

/**
 * Resolve (and cache) the backend adapter for a site.
 * @param {object} site Site config; must include `_name` and may include `api`.
 * @returns {Promise<import("./backend-interface.js").Backend>} A backend instance.
 * @throws {BackendResolutionError} When no configured/probed backend is usable.
 */
export async function resolveBackend(site) {
  if (cache.has(site._name)) return cache.get(site._name);

  const order = normalizeApiOrder(site.api);
  let backend;

  if (order) {
    backend = await firstUsable(site, order);
    if (!backend) {
      throw new BackendResolutionError(
        `Site "${site._name}": none of the configured api backends [${order.join(", ")}] are usable. ` +
        "Check the \"api\" setting and that the endpoint is reachable."
      );
    }
  } else {
    backend = await probe(site);
    if (!backend) {
      throw new BackendResolutionError(
        `Site "${site._name}": could not auto-detect a usable API. ` +
        "Set \"api\" in config (e.g. \"graphql\" or \"jsonapi\")."
      );
    }
  }

  cache.set(site._name, backend);
  return backend;
}

/**
 * Normalize the `api` config into an ordered list of protocol names.
 * @param {string|string[]|undefined|null} api Config value.
 * @returns {string[]|null} Ordered protocol names, or null when unset/invalid.
 */
function normalizeApiOrder(api) {
  if (!api) return null;
  if (typeof api === "string") return [api];
  if (Array.isArray(api)) return api;
  return null;
}

/**
 * Return the first configured backend that is actually reachable.
 * @param {object} site Site config.
 * @param {string[]} order Protocol names in preference order.
 * @returns {Promise<?import("./backend-interface.js").Backend>} Instance or null.
 */
async function firstUsable(site, order) {
  for (const name of order) {
    const Cls = REGISTRY.get(name);
    if (!Cls) continue;
    if (await isReachable(name, site)) return new Cls(site);
  }
  return null;
}

/**
 * Auto-detect a backend by probing each registered protocol in order.
 * @param {object} site Site config.
 * @returns {Promise<?import("./backend-interface.js").Backend>} Instance or null.
 */
async function probe(site) {
  for (const [name, Cls] of REGISTRY) {
    if (await isReachable(name, site)) return new Cls(site);
  }
  return null;
}

/**
 * Probe whether a given protocol responds for a site. Any error counts as
 * unreachable so probing never throws.
 * @param {string} name Protocol name ("jsonapi" | "graphql").
 * @param {object} site Site config.
 * @returns {Promise<boolean>} True when the endpoint answered successfully.
 */
async function isReachable(name, site) {
  try {
    if (name === "jsonapi") {
      await drupalFetch(site, "/jsonapi");
      return true;
    }
    if (name === "graphql") {
      const json = await drupalGraphqlFetch(site, { query: "{ __typename }" });
      return Boolean(json && !json.errors);
    }
    return false;
  } catch {
    return false;
  }
}
