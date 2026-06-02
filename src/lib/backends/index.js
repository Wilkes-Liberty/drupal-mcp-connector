/**
 * Backend resolution: pick a backend for a site using explicit config first,
 * then a one-time capability probe, caching the verdict per site.
 */

import { drupalFetch } from "../drupal-fetch.js";
import { drupalGraphqlFetch } from "../drupal-fetch.js";
import { JsonApiBackend } from "./jsonapi.js";
import { GraphqlBackend } from "./graphql.js";
import { BackendResolutionError } from "./errors.js";

const REGISTRY = new Map([
  ["jsonapi", JsonApiBackend],
  ["graphql", GraphqlBackend],
]);

const cache = new Map();

/** Test helper: clear the per-site backend cache. */
export function _clearBackendCache() {
  cache.clear();
}

/**
 * @param {object} site site config (must include _name)
 * @returns {Promise<import("./backend-interface.js").Backend>}
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

function normalizeApiOrder(api) {
  if (!api) return null;
  if (typeof api === "string") return [api];
  if (Array.isArray(api)) return api;
  return null;
}

async function firstUsable(site, order) {
  for (const name of order) {
    const Cls = REGISTRY.get(name);
    if (!Cls) continue;
    if (await isReachable(name, site)) return new Cls(site);
  }
  return null;
}

async function probe(site) {
  for (const [name, Cls] of REGISTRY) {
    if (await isReachable(name, site)) return new Cls(site);
  }
  return null;
}

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
