/**
 * In-flight request registry keyed by the shared principal formula.
 *
 * A kill or revocation cancels in-flight calls for that principal
 * (DEV-846). The map is bounded; a full registry fails closed.
 */

import { principalDenied } from "./principal-context.js";
import { fromIdentity, PrincipalKeyError } from "./principal-key.js";
import { assertTestOnly } from "./test-only.js";

/** Hard cap on concurrent tracked calls. Mirrors the 2025 session bound. */
export const IN_FLIGHT_MAX_ENTRIES = 128;

/**
 * Per-principal sub-cap. One principal cannot fill the process and deny
 * every other tenant.
 */
export const IN_FLIGHT_MAX_PER_PRINCIPAL = 16;

/**
 * In-process cap guard. Production leaves `enforced` true. Tests call
 * {@link setInFlightCapGuard} for a red run that admits past the bound.
 */
export const IN_FLIGHT_CAP_GUARD = { enforced: true };

/**
 * Flip {@link IN_FLIGHT_CAP_GUARD} for a red-run. Restore `true` after
 * the assertion; production code never calls this.
 *
 * @param {boolean} enforced
 * @returns {void}
 */
export function setInFlightCapGuard(enforced) {
  assertTestOnly("setInFlightCapGuard");
  IN_FLIGHT_CAP_GUARD.enforced = Boolean(enforced);
}

/**
 * @param {object|null|undefined} identity
 * @returns {{principalKey: string, humanKey: string, tenant: string}|null}
 */
export function inFlightKeysFromIdentity(identity) {
  if (!identity || identity.localOperator === true) return null;
  try {
    const keys = fromIdentity(identity);
    const tenant = typeof identity.tenant === "string" ? identity.tenant : "";
    return { principalKey: keys.principalKey, humanKey: keys.humanKey, tenant };
  } catch (err) {
    if (err instanceof PrincipalKeyError) return null;
    throw err;
  }
}

/**
 * Bounded in-flight registry. `begin` fails closed when the cap is hit.
 *
 * @param {{maxEntries?: number, maxPerPrincipal?: number}} [options]
 * @returns {{
 *   begin: (keys: object, extra?: {signal?: AbortSignal}) => {id: string, signal: AbortSignal, end: () => void},
 *   cancel: (selector: {principalKey?: string, humanKey?: string, tenant?: string}) => number,
 *   size: () => number,
 *   reset: () => void,
 * }}
 */
export function createInFlightRegistry({
  maxEntries = IN_FLIGHT_MAX_ENTRIES,
  maxPerPrincipal = IN_FLIGHT_MAX_PER_PRINCIPAL,
} = {}) {
  const cap = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : IN_FLIGHT_MAX_ENTRIES;
  const perPrincipal = Number.isInteger(maxPerPrincipal) && maxPerPrincipal > 0
    ? maxPerPrincipal
    : IN_FLIGHT_MAX_PER_PRINCIPAL;
  /** @type {Map<string, {controller: AbortController, principalKey: string, humanKey: string, tenant: string}>} */
  const entries = new Map();
  let seq = 0;

  function end(id) {
    const row = entries.get(id);
    if (!row) return;
    entries.delete(id);
  }

  return {
    /**
     * Track one in-flight call. Fails closed at the cap.
     *
     * @param {{principalKey?: string, humanKey?: string, tenant?: string}|null} keys
     * @param {{signal?: AbortSignal}} [extra]
     * @returns {{id: string, signal: AbortSignal, end: () => void}}
     */
    begin(keys, extra = {}) {
      if (IN_FLIGHT_CAP_GUARD.enforced && entries.size >= cap) throw principalDenied();
      const principalKey = typeof keys?.principalKey === "string" ? keys.principalKey : "";
      if (IN_FLIGHT_CAP_GUARD.enforced && principalKey) {
        let n = 0;
        for (const row of entries.values()) {
          if (row.principalKey === principalKey) n += 1;
        }
        if (n >= perPrincipal) throw principalDenied();
      }
      const id = `if-${seq += 1}`;
      const controller = new AbortController();
      const humanKey = typeof keys?.humanKey === "string" ? keys.humanKey : "";
      const tenant = typeof keys?.tenant === "string" ? keys.tenant : "";
      const parent = extra.signal;
      if (parent) {
        if (parent.aborted) {
          controller.abort(parent.reason);
        } else {
          parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
        }
      }
      entries.set(id, { controller, principalKey, humanKey, tenant });
      return {
        id,
        signal: controller.signal,
        end: () => end(id),
      };
    },

    /**
     * Abort every in-flight call matching the selector. Empty selector
     * matches nothing (fail closed: do not cancel the world).
     *
     * @param {{principalKey?: string, humanKey?: string, tenant?: string}} selector
     * @returns {number} How many calls were aborted.
     */
    cancel(selector = {}) {
      const principalKey = typeof selector.principalKey === "string" ? selector.principalKey : "";
      const humanKey = typeof selector.humanKey === "string" ? selector.humanKey : "";
      const tenant = typeof selector.tenant === "string" ? selector.tenant : "";
      if (!principalKey && !humanKey && !tenant) return 0;
      let n = 0;
      for (const [id, row] of entries) {
        const match = (principalKey && row.principalKey === principalKey)
          || (humanKey && row.humanKey === humanKey)
          || (tenant && row.tenant === tenant);
        if (!match) continue;
        try {
          row.controller.abort(principalDenied());
        } catch {
          // Abort must still drop the row.
        }
        entries.delete(id);
        n += 1;
      }
      return n;
    },

    size() {
      return entries.size;
    },

    reset() {
      for (const row of entries.values()) {
        try { row.controller.abort(principalDenied()); } catch { /* ignore */ }
      }
      entries.clear();
    },
  };
}

const defaultRegistry = createInFlightRegistry();

/**
 * Process-wide registry used by HTTP dispatch. Tests may {@link setInFlightRegistry}.
 *
 * @returns {ReturnType<typeof createInFlightRegistry>}
 */
export function getInFlightRegistry() {
  return defaultRegistry;
}

let activeRegistry = defaultRegistry;

/**
 * @param {ReturnType<typeof createInFlightRegistry>|null} registry
 * @returns {void}
 */
export function setInFlightRegistry(registry) {
  assertTestOnly("setInFlightRegistry");
  activeRegistry = registry || defaultRegistry;
}

/**
 * @returns {ReturnType<typeof createInFlightRegistry>}
 */
export function activeInFlightRegistry() {
  return activeRegistry;
}
