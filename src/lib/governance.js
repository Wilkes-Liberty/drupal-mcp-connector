/**
 * Source-governance verification for governed sites (#176).
 *
 * A site with `requireGovernance: true` declares that every product path —
 * tool discovery and execution, on every backend — depends on the Drupal
 * source's governance layer (MCP Sentinel) being present, applicable, and
 * enforcing. The connector verifies that claim against the source's own
 * readiness contract (`GET /drupal-mcp/readiness`, authenticated as the
 * connector's principal) and DENIES instead of falling back to a plain
 * JSON:API or GraphQL path when the contract is not ready, cannot be
 * reached, or the verification has gone stale and cannot be refreshed.
 *
 * The readiness endpoint answers for the whole contract: module present,
 * an applicable active policy/profile for the requesting principal, and the
 * enforcement wiring active. Its `reason` values are stable, non-secret
 * diagnostics designed to be surfaced to operators verbatim.
 */

import fetch from "node-fetch";
import { authHeadersAsync, clientHeaders } from "./config.js";

/** How long a passing verification stays fresh before it must be re-proven. */
export const OK_TTL_MS = 60_000;

/** How long a failed verification is held before the next attempt re-checks. */
export const FAIL_TTL_MS = 5_000;

/** Tools that stay discoverable and callable while governance is failing —
 * the diagnostic surface an operator needs to see WHY it is failing. */
export const GOVERNANCE_DIAGNOSTIC_TOOLS = new Set([
  "drupal_list_sites",
  "drupal_governance_status",
]);

/** Denial for a governed path whose source-governance contract is not verified. */
export class GovernanceError extends Error {
  /**
   * @param {string} message Operator-facing description (no secrets).
   * @param {string} reason  Stable machine reason (e.g. "sentinel_unreachable").
   */
  constructor(message, reason) {
    super(message);
    this.name = "GovernanceError";
    this.reason = reason;
  }
}

/** Per-site verification cache: name → {ok, reason, checkedAt}. */
const cache = new Map();

/** Drop all cached verifications (tests, config reloads). */
export function clearGovernanceCache() {
  cache.clear();
}

/**
 * Whether a site declares the source-governance requirement.
 * @param {object} site Resolved site config.
 * @returns {boolean}
 */
export function requiresGovernance(site) {
  return site?.requireGovernance === true;
}

/**
 * Verify the site's source-governance contract, with a short-lived cache.
 *
 * Never throws: the result carries `ok` plus a stable `reason` on failure.
 * A stale cache entry is re-verified; if the re-check cannot happen the
 * result is a failure — staleness never extends trust.
 *
 * @param {object} site Resolved site config.
 * @param {{force?: boolean}} [options] `force` bypasses the cache.
 * @returns {Promise<{ok: boolean, reason: string|null, checkedAt: number}>}
 */
export async function verifySourceGovernance(site, { force = false } = {}) {
  const key = site._name ?? site.baseUrl;
  const cached = cache.get(key);
  if (!force && cached) {
    const age = Date.now() - cached.checkedAt;
    if (age <= (cached.ok ? OK_TTL_MS : FAIL_TTL_MS)) return cached;
  }

  const result = await probeReadiness(site);
  cache.set(key, result);
  return result;
}

/**
 * One authenticated readiness probe; maps every outcome to {ok, reason}.
 * @param {object} site Resolved site config.
 * @returns {Promise<{ok: boolean, reason: string|null, checkedAt: number}>}
 */
async function probeReadiness(site) {
  const checkedAt = Date.now();

  // Credential construction is its own failure class: an OAuth token the
  // connector cannot acquire is the connector's principal failing, and must
  // not be misreported as the source being unreachable.
  let headers;
  try {
    headers = {
      Accept: "application/json",
      ...clientHeaders(),
      ...(await authHeadersAsync(site)),
    };
  } catch {
    return { ok: false, reason: "credential_acquisition_failed", checkedAt };
  }

  let res;
  try {
    res = await fetch(`${site.baseUrl}/drupal-mcp/readiness`, { method: "GET", headers });
  } catch {
    // Network detail (addresses, DNS text) is deliberately not propagated.
    return { ok: false, reason: "sentinel_unreachable", checkedAt };
  }

  if (res.status === 404) {
    return { ok: false, reason: "sentinel_unavailable", checkedAt };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "not_authorized_for_governance", checkedAt };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "unexpected_response", checkedAt };
  }

  if (res.status === 200 && body?.contract_ready === true) {
    return { ok: true, reason: null, checkedAt };
  }
  if (body?.contract_ready === false) {
    // The server's own stable, non-secret readiness reason.
    return { ok: false, reason: String(body.reason ?? "contract_not_ready"), checkedAt };
  }
  return { ok: false, reason: "unexpected_response", checkedAt };
}

/**
 * Gate a governed product path: no-op for ungoverned sites, throws otherwise
 * unless the source contract verifies.
 *
 * @param {object} site Resolved site config.
 * @returns {Promise<void>}
 * @throws {GovernanceError} naming the failed condition (never secrets).
 */
export async function assertSourceGovernance(site) {
  if (!requiresGovernance(site)) return;
  const result = await verifySourceGovernance(site);
  if (result.ok) return;
  throw new GovernanceError(
    `Site "${site._name}" requires source governance and the contract is not verified ` +
    `(${result.reason}). Governed paths are denied — there is no ungoverned fallback. ` +
    "Run drupal_governance_status for per-site diagnostics.",
    result.reason,
  );
}

/**
 * Per-site governance condition for operator diagnostics. No secrets: only
 * the site name, whether governance is required, the verdict, and the reason.
 *
 * @param {Array<object>} sites Resolved site configs.
 * @returns {Promise<Array<{site: string, required: boolean, ok: boolean, reason: string|null, checkedAt: number|null}>>}
 */
export async function governanceStatus(sites) {
  return Promise.all(sites.map(async (site) => {
    if (!requiresGovernance(site)) {
      return { site: site._name, required: false, ok: true, reason: null, checkedAt: null };
    }
    const result = await verifySourceGovernance(site);
    return {
      site: site._name,
      required: true,
      ok: result.ok,
      reason: result.reason,
      checkedAt: result.checkedAt,
    };
  }));
}

/**
 * Discovery gate: hide governed tools when NO configured site can serve them.
 *
 * A site can serve governed tools when it is either ungoverned or its source
 * contract verifies. While at least one site qualifies the full surface stays
 * discoverable (execution remains per-site gated); when none does, only the
 * diagnostic tools remain, so a client sees the denial instead of a surface
 * it cannot use.
 *
 * @param {Array<object>} definitions Tool definitions ({name, ...}).
 * @param {Array<object>} sites       Resolved site configs.
 * @returns {Promise<Array<object>>} The discoverable definitions.
 */
export async function filterDiscoverableTools(definitions, sites) {
  const verdicts = await Promise.all(sites.map(async (site) =>
    !requiresGovernance(site) || (await verifySourceGovernance(site)).ok));
  if (verdicts.some(Boolean)) return definitions;
  return definitions.filter((d) => GOVERNANCE_DIAGNOSTIC_TOOLS.has(d.name));
}
