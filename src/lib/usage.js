/**
 * Attributable usage, quotas, and abuse signals on the relay edge (#256 /
 * DEV-126).
 *
 * Metering at the seam, lab bounds. Every edge decision (allow or deny) and
 * every fan-down receipt is a record keyed by the grant-resolved tenant and
 * the validated principal, carrying the request / decision / receipt ids the
 * frame already stamps. Quotas fail closed at this boundary: a tenant or
 * principal without a row is refused, an exhausted window is refused, and a
 * principal that keeps earning denials is locked. Cost signals are measured
 * (units, bytes, duration), never priced — pricing and invoicing are not this
 * module.
 *
 * Nothing here is a hosted metering sink. The ledger is in-process and
 * bounded; a restart clears it, and `reconcileUsage` says so when it dropped
 * rows. Caller-supplied tenant / principal fields are never authority: the
 * edge attributes from its own identity object and grant tables.
 */

import { randomUUID } from "node:crypto";
import { createRateLimiter } from "./rate-limit.js";

/** Record phases. A denied decision never has a receipt. */
export const USAGE_PHASES = Object.freeze(["decision", "receipt"]);

/** Decision vocabulary at the edge. */
export const USAGE_DECISIONS = Object.freeze(["allow", "deny"]);

/**
 * Receipt outcomes. `unknown` means the frame crossed but no settled
 * response came back — the tenant may have executed the request.
 */
export const RECEIPT_OUTCOMES = Object.freeze(["ok", "failed", "unknown"]);

/** Reconciliation states over one request / decision / receipt chain. */
export const RECONCILE_STATES = Object.freeze([
  "settled",
  "denied",
  "missing",
  "duplicate",
  "uncertain",
]);

const PHASE_SET = new Set(USAGE_PHASES);
const DECISION_SET = new Set(USAGE_DECISIONS);
const OUTCOME_SET = new Set(RECEIPT_OUTCOMES);

const DEFAULT_WINDOW_SEC = 60;
const DEFAULT_LOCK_SEC = 300;
const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_MAX_KEYS = 10_000;

function cleanKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return key && !key.startsWith("_") ? key : "";
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function grantIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => cleanKey(value)).filter(Boolean))];
}

/**
 * Principal partition key: inbound `sub`, then `azp` / client id. Matches
 * the precedence of `auth.actors` and `auth.policies`. Never a caller field.
 *
 * @param {object|null} identity
 * @returns {string|null}
 */
export function usagePrincipalKey(identity) {
  if (!isRecord(identity)) return null;
  const sub = typeof identity.sub === "string" ? identity.sub.trim() : "";
  if (sub) return sub;
  const clientId = typeof identity.clientId === "string" ? identity.clientId.trim() : "";
  return clientId || null;
}

/**
 * Tenant a principal's usage is attributed to when the edge has not yet
 * routed (early denials): the unique tenant its grant names, else null.
 * Attribution only — routing authority stays with `resolveTenantRoute`.
 *
 * @param {object|null} identity
 * @param {object|null} tenantGrants
 * @returns {string|null}
 */
export function attributedTenant(identity, tenantGrants) {
  if (!isRecord(identity) || !isRecord(tenantGrants)) return null;
  const clientId = typeof identity.clientId === "string" ? identity.clientId : "";
  if (!clientId) return null;
  const granted = grantIds(new Map(Object.entries(tenantGrants)).get(clientId));
  return granted.length === 1 ? granted[0] : null;
}

const QUOTA_KEYS = new Set(["tenants", "principals", "abuse"]);

function invalid(reason) {
  return Object.freeze({ invalid: true, reason });
}

/**
 * @returns {{rows: object, required: boolean}|{invalid: true, reason: string}}
 */
function quotaRows(raw, name) {
  if (raw === undefined || raw === null) return { rows: Object.freeze({}), required: false };
  if (!isRecord(raw)) return invalid(name);
  const entries = [];
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = cleanKey(rawKey);
    if (!key) continue;
    if (!isRecord(value)) return invalid(`${name}.${key}`);
    const requests = positiveInt(value.requests);
    if (requests === null) return invalid(`${name}.${key}.requests`);
    const windowSec = value.windowSec === undefined
      ? DEFAULT_WINDOW_SEC
      : positiveInt(value.windowSec);
    if (windowSec === null) return invalid(`${name}.${key}.windowSec`);
    entries.push([key, Object.freeze({ requests, windowSec })]);
  }
  return { rows: Object.freeze(Object.fromEntries(entries)), required: entries.length > 0 };
}

function abuseBlock(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return invalid("abuse");
  const denials = positiveInt(raw.denials);
  if (denials === null) return invalid("abuse.denials");
  const windowSec = raw.windowSec === undefined ? DEFAULT_WINDOW_SEC : positiveInt(raw.windowSec);
  if (windowSec === null) return invalid("abuse.windowSec");
  const lockSec = raw.lockSec === undefined ? DEFAULT_LOCK_SEC : positiveInt(raw.lockSec);
  if (lockSec === null) return invalid("abuse.lockSec");
  return Object.freeze({ denials, windowSec, lockSec });
}

/**
 * Normalize `auth.quotas`.
 *
 * Shape: `{ tenants: { "<agentId>": { requests, windowSec? } },
 * principals: { "<sub|azp>": { requests, windowSec? } },
 * abuse: { denials, windowSec?, lockSec? } }`. Comment keys are ignored.
 * Anything else that is not exactly that shape — an unknown key, a
 * sub-table that is not an object, a row with a non-positive-integer
 * `requests` / `windowSec`, a malformed `abuse` block — makes the whole
 * table **invalid**, never "omitted": the gate then refuses everything and
 * the edge refuses to start. A sub-table that names any id is *required*,
 * so an id without a row fails closed.
 *
 * @param {object|null} raw
 * @returns {object|null} Null when the table is omitted or comment-only;
 *   `{ invalid: true, reason }` naming the offending path; else the table.
 */
export function normalizeQuotas(raw) {
  if (!isRecord(raw)) return null;
  for (const rawKey of Object.keys(raw)) {
    const key = cleanKey(rawKey);
    if (key && !QUOTA_KEYS.has(key)) return invalid(key);
  }
  const bag = new Map(Object.entries(raw));
  const tenants = quotaRows(bag.get("tenants"), "tenants");
  if (tenants.invalid) return tenants;
  const principals = quotaRows(bag.get("principals"), "principals");
  if (principals.invalid) return principals;
  const abuse = abuseBlock(bag.get("abuse"));
  if (abuse?.invalid) return abuse;
  if (!tenants.required && !principals.required && abuse === null) return null;
  return Object.freeze({
    tenants: tenants.rows,
    tenantsRequired: tenants.required,
    principals: principals.rows,
    principalsRequired: principals.required,
    abuse,
  });
}

/**
 * Whether a quota table is in force (fail-closed even when every row is
 * malformed).
 *
 * @param {object|null} raw
 * @returns {boolean}
 */
export function quotasRequired(raw) {
  return normalizeQuotas(raw) !== null;
}

/**
 * Quota and abuse gate. Fixed windows per tenant and per principal, plus a
 * denial counter that locks a principal. Every request reaching `check`
 * counts against the applicable windows whether or not it is then allowed,
 * so a flood of refused requests cannot probe for free.
 *
 * @param {object} [options]
 * @param {object|null} [options.quotas] Raw `auth.quotas`.
 * @param {() => number} [options.now]
 * @param {number} [options.maxKeys] Soft cap on tracked principals in the
 *   abuse table; expired entries are pruned first, then the oldest.
 * @returns {{enabled: boolean, check: Function, noteDenial: Function, state: Function, stats: Function}}
 */
export function createQuotaGate({
  quotas = null,
  now = () => Date.now(),
  maxKeys = DEFAULT_MAX_KEYS,
} = {}) {
  const table = normalizeQuotas(quotas);
  if (!table) {
    return Object.freeze({
      enabled: false,
      invalid: false,
      reason: null,
      check: () => ({ allowed: true }),
      noteDenial: () => ({ locked: false }),
      state: () => ({ locked: false, retryAfterSec: 0, denials: 0 }),
      stats: () => ({ trackedPrincipals: 0, maxKeys: 0 }),
    });
  }
  if (table.invalid) {
    // A quota table that cannot be read authorizes nobody. The edge refuses
    // to start on this; the gate refuses every request as defense in depth.
    return Object.freeze({
      enabled: true,
      invalid: true,
      reason: table.reason,
      check: () => ({ allowed: false, reason: "not_entitled", scope: "config", retryAfterSec: 0 }),
      noteDenial: () => ({ locked: false }),
      state: () => ({ locked: false, retryAfterSec: 0, denials: 0 }),
      stats: () => ({ trackedPrincipals: 0, maxKeys: 0 }),
    });
  }

  function limiters(rows) {
    return new Map(Object.entries(rows).map(([id, row]) => [
      id,
      createRateLimiter({ limit: row.requests, windowMs: row.windowSec * 1000, now }),
    ]));
  }
  const tenantLimiters = limiters(table.tenants);
  const principalLimiters = limiters(table.principals);
  const abuse = table.abuse;
  const keyBound = positiveInt(maxKeys) ?? DEFAULT_MAX_KEYS;
  /** @type {Map<string, {times: number[], lockedUntil: number}>} */
  const denials = new Map();

  function live(entry, t) {
    if (entry.lockedUntil > t) return true;
    if (entry.lockedUntil) return false;
    return entry.times.some((ts) => t - ts < abuse.windowSec * 1000);
  }

  /** Drop expired principals; if still at the bound, drop the oldest. */
  function prune(t) {
    for (const [key, entry] of denials) {
      if (!live(entry, t)) denials.delete(key);
    }
    while (denials.size >= keyBound) {
      const oldest = denials.keys().next().value;
      if (oldest === undefined) break;
      denials.delete(oldest);
    }
  }

  function deny(reason, scope, retryAfterSec = 0) {
    return { allowed: false, reason, scope, retryAfterSec };
  }

  function lockState(key) {
    if (!abuse || !key) return { locked: false, retryAfterSec: 0, denials: 0 };
    const entry = denials.get(key);
    if (!entry) return { locked: false, retryAfterSec: 0, denials: 0 };
    const t = now();
    if (entry.lockedUntil > t) {
      return {
        locked: true,
        retryAfterSec: Math.ceil((entry.lockedUntil - t) / 1000),
        denials: entry.times.length,
      };
    }
    if (entry.lockedUntil) {
      denials.delete(key);
      return { locked: false, retryAfterSec: 0, denials: 0 };
    }
    entry.times = entry.times.filter((ts) => t - ts < abuse.windowSec * 1000);
    if (!entry.times.length) denials.delete(key);
    return { locked: false, retryAfterSec: 0, denials: entry.times.length };
  }

  return Object.freeze({
    enabled: true,
    invalid: false,
    reason: null,

    /**
     * @param {{tenant?: string|null, principalKey?: string|null}} params
     * @returns {{allowed: true}|{allowed: false, reason: string, scope: string, retryAfterSec: number}}
     */
    check({ tenant = null, principalKey = null } = {}) {
      const key = cleanKey(principalKey);
      const lock = lockState(key);
      if (lock.locked) return deny("abuse_locked", "abuse", lock.retryAfterSec);
      if (table.tenantsRequired) {
        const tenantId = cleanKey(tenant);
        const limiter = tenantId ? tenantLimiters.get(tenantId) : undefined;
        if (!limiter) return deny("not_entitled", "tenant");
        const verdict = limiter.check(tenantId);
        if (!verdict.allowed) return deny("quota_exceeded", "tenant", verdict.retryAfterSec);
      }
      if (table.principalsRequired) {
        const limiter = key ? principalLimiters.get(key) : undefined;
        if (!limiter) return deny("not_entitled", "principal");
        const verdict = limiter.check(key);
        if (!verdict.allowed) return deny("quota_exceeded", "principal", verdict.retryAfterSec);
      }
      return { allowed: true };
    },

    /**
     * Count one post-authentication denial against a principal.
     * @param {string|null} principalKey
     * @returns {{locked: boolean, retryAfterSec?: number}}
     */
    noteDenial(principalKey) {
      if (!abuse) return { locked: false };
      const key = cleanKey(principalKey);
      if (!key) return { locked: false };
      const current = lockState(key);
      if (current.locked) return { locked: true, retryAfterSec: current.retryAfterSec };
      const entry = denials.get(key) ?? { times: [], lockedUntil: 0 };
      if (!denials.has(key) && denials.size >= keyBound) prune(now());
      entry.times.push(now());
      denials.set(key, entry);
      if (entry.times.length >= abuse.denials) {
        entry.lockedUntil = now() + abuse.lockSec * 1000;
        return { locked: true, retryAfterSec: abuse.lockSec };
      }
      return { locked: false };
    },

    /**
     * @param {string|null} principalKey
     * @returns {{locked: boolean, retryAfterSec: number, denials: number}}
     */
    state(principalKey) {
      return lockState(cleanKey(principalKey));
    },

    /** @returns {{trackedPrincipals: number, maxKeys: number}} */
    stats() {
      return { trackedPrincipals: denials.size, maxKeys: keyBound };
    },
  });
}

/**
 * Bounded in-process usage ledger.
 *
 * Decision records carry `decision` (`allow` / `deny`), `reason`,
 * `requestId` (the frame id, only when dispatched), and a `decisionId`.
 * Receipt records carry `outcome`, `status`, cost signals, the same
 * `requestId`, and the `decisionId` they settle. Records are frozen.
 *
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.maxRecords] Oldest rows are dropped beyond this.
 * @returns {object}
 */
export function createUsageLedger({
  now = () => Date.now(),
  maxRecords = DEFAULT_MAX_RECORDS,
} = {}) {
  const bound = positiveInt(maxRecords);
  if (bound === null) {
    throw new TypeError("createUsageLedger requires maxRecords to be a positive integer.");
  }
  const rows = [];
  let seq = 0;
  let dropped = 0;

  return {
    get size() {
      return rows.length;
    },

    /**
     * @param {object} entry
     * @returns {object} The frozen, stamped record.
     */
    record(entry) {
      if (!isRecord(entry)) throw new TypeError("A usage record must be an object.");
      const bag = new Map(Object.entries(entry));
      const phase = bag.get("phase");
      if (!PHASE_SET.has(phase)) throw new TypeError(`Unknown usage phase: ${String(phase)}`);
      if (phase === "decision" && !DECISION_SET.has(bag.get("decision"))) {
        throw new TypeError(`Unknown usage decision: ${String(bag.get("decision"))}`);
      }
      if (phase === "receipt" && !OUTCOME_SET.has(bag.get("outcome"))) {
        throw new TypeError(`Unknown receipt outcome: ${String(bag.get("outcome"))}`);
      }
      seq += 1;
      const existingDecision = bag.get("decisionId");
      const stamped = {
        ...entry,
        seq,
        at: new Date(now()).toISOString(),
        decisionId: typeof existingDecision === "string" && existingDecision
          ? existingDecision
          : (phase === "decision" ? randomUUID() : null),
      };
      if (phase === "receipt") {
        const existingReceipt = bag.get("receiptId");
        stamped.receiptId = typeof existingReceipt === "string" && existingReceipt
          ? existingReceipt
          : randomUUID();
      }
      const frozen = Object.freeze(stamped);
      rows.push(frozen);
      if (rows.length > bound) {
        rows.shift();
        dropped += 1;
      }
      return frozen;
    },

    /** @returns {object[]} Every retained record, oldest first. */
    records() {
      return rows.slice();
    },

    /**
     * One tenant partition, optionally narrowed to one principal. A missing
     * tenant selects nothing — there is no all-tenants read on this surface.
     *
     * @param {{tenant?: string|null, principalKey?: string|null}} [params]
     * @returns {object[]}
     */
    query({ tenant = null, principalKey = null } = {}) {
      const tenantId = typeof tenant === "string" ? tenant.trim() : "";
      if (!tenantId) return [];
      const key = typeof principalKey === "string" && principalKey.trim()
        ? principalKey.trim()
        : null;
      return rows.filter((row) => row.tenant === tenantId
        && (key === null || row.principalKey === key));
    },

    /** @returns {{size: number, dropped: number, maxRecords: number}} */
    stats() {
      return { size: rows.length, dropped, maxRecords: bound };
    },
  };
}

const READ_DENIED = Object.freeze({ ok: false, reason: "not_entitled" });

/**
 * Tenant-scoped usage read. The tenant is resolved from the caller's
 * `auth.tenantGrants` row; a `tenant` argument is a confirming hint inside
 * that grant, never authority. Without a grant table, without a ledger, for
 * a principal with no grant, for a hint outside the grant, or for a
 * multi-tenant grant with no hint, the read is `not_entitled` with no
 * records.
 *
 * @param {object} params
 * @param {object|null} [params.identity]
 * @param {object|null} [params.tenantGrants]
 * @param {string|null} [params.tenant]
 * @param {string|null} [params.principalKey]
 * @param {object|null} [params.ledger]
 * @returns {{ok: true, tenant: string, records: object[]}|{ok: false, reason: "not_entitled"}}
 */
export function readUsage({
  identity = null,
  tenantGrants = null,
  tenant = null,
  principalKey = null,
  ledger = null,
} = {}) {
  if (!ledger || typeof ledger.query !== "function") return READ_DENIED;
  if (!isRecord(identity) || typeof identity.clientId !== "string" || !identity.clientId) {
    return READ_DENIED;
  }
  if (!isRecord(tenantGrants)) return READ_DENIED;
  const granted = grantIds(new Map(Object.entries(tenantGrants)).get(identity.clientId));
  if (!granted.length) return READ_DENIED;
  const hint = typeof tenant === "string" && tenant.trim() ? tenant.trim() : null;
  if (hint && !granted.includes(hint)) return READ_DENIED;
  if (!hint && granted.length > 1) return READ_DENIED;
  const resolved = hint ?? granted[0];
  const key = typeof principalKey === "string" && principalKey.trim() ? principalKey.trim() : null;
  return { ok: true, tenant: resolved, records: ledger.query({ tenant: resolved, principalKey: key }) };
}

/**
 * Reconcile a set of records into request / decision / receipt chains.
 *
 * - `settled`: one allow decision, one receipt, matching tenant and
 *   decision id, outcome known.
 * - `denied`: a deny decision (never dispatched; no receipt expected).
 * - `missing`: a dispatch with no receipt, or a receipt with no dispatch.
 * - `duplicate`: more than one decision or more than one receipt for a
 *   request id.
 * - `uncertain`: the receipt outcome is `unknown`, or the receipt disagrees
 *   with its decision (tenant or decision id).
 *
 * `truncated` is true when the ledger dropped rows; findings may then be
 * incomplete and must not be read as a clean bill.
 *
 * @param {object[]} records
 * @param {{dropped?: number}} [options]
 * @returns {{findings: object[], summary: object}}
 */
export function reconcileUsage(records, { dropped = 0 } = {}) {
  const list = Array.isArray(records) ? records : [];
  const order = [];
  const groups = new Map();

  for (const row of list) {
    if (!isRecord(row) || !PHASE_SET.has(row.phase)) continue;
    if (row.phase === "decision" && row.decision === "deny") {
      const key = `deny:${row.decisionId ?? order.length}`;
      order.push(key);
      groups.set(key, { deny: row });
      continue;
    }
    const requestId = typeof row.requestId === "string" && row.requestId ? row.requestId : null;
    const key = requestId
      ? `req:${requestId}`
      : `orphan:${row.decisionId ?? row.receiptId ?? order.length}`;
    if (!groups.has(key)) {
      order.push(key);
      groups.set(key, { requestId, decisions: [], receipts: [] });
    }
    const group = groups.get(key);
    if (row.phase === "decision") group.decisions.push(row);
    else group.receipts.push(row);
  }

  const findings = [];
  const summary = {
    total: 0, settled: 0, denied: 0, missing: 0, duplicate: 0, uncertain: 0, truncated: dropped > 0,
  };
  const tally = new Map(Object.entries(summary));

  for (const key of order) {
    const group = groups.get(key);
    let finding;
    if (group.deny) {
      finding = {
        requestId: group.deny.requestId ?? null,
        decisionId: group.deny.decisionId ?? null,
        state: "denied",
        reason: group.deny.reason ?? null,
      };
    } else {
      const decisionId = group.decisions[0]?.decisionId ?? group.receipts[0]?.decisionId ?? null;
      let state;
      let reason;
      if (group.decisions.length > 1) {
        state = "duplicate";
        reason = "duplicate_decision";
      } else if (group.receipts.length > 1) {
        state = "duplicate";
        reason = "duplicate_receipt";
      } else if (group.decisions.length === 1 && group.receipts.length === 0) {
        state = "missing";
        reason = "receipt_missing";
      } else if (group.decisions.length === 0) {
        state = "missing";
        reason = "decision_missing";
      } else {
        const decision = group.decisions[0];
        const receipt = group.receipts[0];
        if (receipt.outcome === "unknown") {
          state = "uncertain";
          reason = typeof receipt.reason === "string" && receipt.reason
            ? receipt.reason
            : "outcome_unknown";
        } else if (receipt.tenant !== decision.tenant || receipt.decisionId !== decision.decisionId) {
          state = "uncertain";
          reason = "chain_mismatch";
        } else {
          state = "settled";
          reason = null;
        }
      }
      finding = { requestId: group.requestId, decisionId, state, reason };
    }
    findings.push(Object.freeze(finding));
    tally.set(finding.state, tally.get(finding.state) + 1);
    tally.set("total", tally.get("total") + 1);
  }

  return { findings, summary: Object.fromEntries(tally) };
}
