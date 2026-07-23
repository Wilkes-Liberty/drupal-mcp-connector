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
import { clearToken } from "../oauth.js";
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
 * Classify a probe failure as an authentication problem (expired/invalid OAuth
 * token or bad client credentials) rather than an unreachable endpoint. This is
 * the distinction #119 needs: an auth failure and a network failure demand
 * different fixes, and the generic "endpoint not reachable" message sent
 * operators to the wrong place.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAuthError(err) {
  const msg = String(err?.message || "");
  return (
    /\b401\b/.test(msg) ||
    (/\b403\b/.test(msg) && /token|oauth|credential|scope/i.test(msg)) ||
    /invalid_client|invalid_grant|unauthorized_client|invalid_token/i.test(msg) ||
    /\bunauthorized\b/i.test(msg)
  );
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
  const probeOrder = order ?? [...REGISTRY.keys()];
  const { backend, failures } = await resolveFromOrder(site, probeOrder);

  if (!backend) throw buildResolutionError(site, order, failures);

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
 * Probe each protocol in order, returning the first usable backend plus the
 * per-protocol failures (captured, not swallowed) for diagnostics.
 * @param {object} site Site config.
 * @param {string[]} order Protocol names in preference order.
 * @returns {Promise<{backend: ?import("./backend-interface.js").Backend, failures: {name: string, error: Error}[]}>}
 */
async function resolveFromOrder(site, order) {
  const failures = [];
  for (const name of order) {
    const Cls = REGISTRY.get(name);
    if (!Cls) {
      failures.push({ name, error: new Error(`no adapter registered for "${name}"`) });
      continue;
    }
    const { ok, error } = await probeProtocol(name, site);
    if (ok) return { backend: new Cls(site), failures };
    failures.push({ name, error });
  }
  return { backend: null, failures };
}

/**
 * Probe whether a given protocol responds for a site. Unlike a boolean probe,
 * this captures the underlying error so resolution can tell an auth failure from
 * an unreachable endpoint (#119).
 * @param {string} name Protocol name ("jsonapi" | "graphql").
 * @param {object} site Site config.
 * @returns {Promise<{ok: boolean, error: ?Error}>}
 */
async function probeProtocol(name, site) {
  try {
    if (name === "jsonapi") {
      await drupalFetch(site, "/jsonapi");
      return { ok: true, error: null };
    }
    if (name === "graphql") {
      const json = await drupalGraphqlFetch(site, { query: "{ __typename }" });
      if (json && !json.errors) return { ok: true, error: null };
      return { ok: false, error: new Error(json?.errors?.[0]?.message || "GraphQL probe returned errors") };
    }
    return { ok: false, error: new Error(`unknown backend "${name}"`) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Build a diagnostic BackendResolutionError from the captured probe failures.
 * An auth failure gets its own message (and clears the cached token so the next
 * call re-attempts the grant instead of latching "unusable"); otherwise the
 * message points at reachability/config — but always includes the underlying
 * error so the operator is not sent to the wrong place (#119).
 * @param {object} site Site config.
 * @param {?string[]} order The configured api order (null when auto-detecting).
 * @param {{name: string, error: Error}[]} failures Per-protocol failures.
 * @returns {BackendResolutionError}
 */
function buildResolutionError(site, order, failures) {
  const detail = failures.map((f) => `${f.name}: ${f.error?.message || "unknown error"}`).join(" | ");
  const authFailure = failures.some((f) => isAuthError(f.error));

  if (authFailure) {
    // Recovery: drop any cached token so the next resolveBackend re-grants
    // (client_credentials refresh) rather than replaying a stale/invalid token.
    if (site.oauth) clearToken(site);
    return new BackendResolutionError(
      `Site "${site._name}": authentication failed against the configured backend(s) — ` +
      "this is an auth problem (expired/invalid OAuth token or client credentials), not reachability. " +
      `Underlying: ${detail}. ` +
      "Check the OAuth client_id/secret and scopes. The cached token has been cleared, so the next call will re-attempt the grant."
    );
  }

  if (order) {
    return new BackendResolutionError(
      `Site "${site._name}": none of the configured api backends [${order.join(", ")}] are usable. ` +
      `Check the "api" setting and that the endpoint is reachable. Underlying: ${detail}.`
    );
  }

  return new BackendResolutionError(
    `Site "${site._name}": could not auto-detect a usable API. ` +
    `Set "api" in config (e.g. "graphql" or "jsonapi"). Underlying: ${detail}.`
  );
}
