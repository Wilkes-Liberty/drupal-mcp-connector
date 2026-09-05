/**
 * Independently verifiable evidence (#261).
 *
 * Reconciles one governed execution by stable identifiers, submits the
 * minimized digest to an independent notary, and exports a tenant-scoped
 * assessor pack bound to the live policy digest. Caller tenant / identity
 * fields are never authority. Prompts, payloads, and secrets never enter
 * the ledger or the export.
 *
 * Lab/loopback only. Not a hosted-service or design-partner admission claim.
 * Audit Chain NDJSON is the off-system stream, not this anchor.
 */

import { digestPayload } from "./contracts/types.js";
import { loadPinnedPublicKey, verifyInclusion } from "./anchor.js";
import { POLICY_DIGEST } from "./policy-promotion.js";

/** Explicit absences are identifiers, not missing fields. */
export const ABSENT = Object.freeze({
  delegation: "none:no_delegation",
  obligations: "none:no_obligations",
  approval: "none:not_required",
  targetRevision: "none:not_observed",
  localExecution: "none:not_dispatched",
});

/** The eight identifiers a governed execution must carry. */
export const EXECUTION_IDS = Object.freeze([
  "identityId",
  "delegationId",
  "decisionId",
  "obligationId",
  "approvalId",
  "localExecutionId",
  "targetRevision",
  "receiptId",
]);

export const RECONCILE_STATES = Object.freeze([
  "settled",
  "incomplete",
  "mismatched",
]);

const DEFAULT_MAX_RECORDS = 10_000;

const FORBIDDEN_EXPORT_KEYS = new Set([
  "prompt",
  "payload",
  "email",
  "mail",
  "ip",
  "useragent",
  "user-agent",
  "body",
  "arguments",
  "secret",
  "token",
  "password",
  "authorization",
  "cookie",
  "clientsecret",
]);

/**
 * Controls the assessor may cite. Prior labs are residual in this export
 * unless this pack carries evidence for them. Never "passed".
 */
export const ASSESSOR_CONTROL_CATALOG = Object.freeze([
  Object.freeze({ id: "P5.3", title: "Tenant secret isolation", source: "prior_lab" }),
  Object.freeze({ id: "P5.5", title: "Token-resolved routing", source: "prior_lab" }),
  Object.freeze({ id: "P5.4", title: "Signed policy lifecycle", source: "prior_lab" }),
  Object.freeze({ id: "P8.5", title: "Local policy continuity", source: "prior_lab" }),
  Object.freeze({ id: "P5.6", title: "Attributable usage", source: "prior_lab" }),
  Object.freeze({ id: "P8.7", title: "Independent evidence anchoring", source: "anchor" }),
  Object.freeze({ id: "P8.8", title: "Data-minimized provenance", source: "anchor" }),
  Object.freeze({ id: "P8.10", title: "Execution reconciliation", source: "anchor" }),
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return key && !key.startsWith("_") ? key : "";
}

function grantIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => cleanKey(value)).filter(Boolean))];
}

function identifier(value, fallback = "") {
  const id = typeof value === "string" ? value.trim() : "";
  return id || fallback;
}

function invalid(reason) {
  return Object.freeze({ invalid: true, reason });
}

function isLoopbackUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1"
      || parsed.hostname === "localhost"
      || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Digest of the inbound principal. Tokens and secrets are not inputs.
 *
 * @param {object|null} identity
 * @returns {string}
 */
export function identityId(identity) {
  if (!isRecord(identity)) return "";
  const issuer = typeof identity.iss === "string"
    ? identity.iss
    : (typeof identity.issuer === "string" ? identity.issuer : "");
  const subject = typeof identity.sub === "string" && identity.sub
    ? identity.sub
    : (typeof identity.subject === "string" ? identity.subject : "");
  const clientId = typeof identity.clientId === "string" ? identity.clientId : "";
  if (!subject && !clientId) return "";
  return digestPayload({ issuer, subject, clientId });
}

/**
 * @param {string|null|undefined} delegator
 * @returns {string}
 */
export function delegationId(delegator) {
  return identifier(delegator, ABSENT.delegation);
}

/**
 * @param {unknown} obligations
 * @returns {string}
 */
export function obligationId(obligations) {
  if (!Array.isArray(obligations) || obligations.length === 0) return ABSENT.obligations;
  return digestPayload(obligations);
}

/**
 * @param {string|null|undefined} approval
 * @returns {string}
 */
export function approvalId(approval) {
  return identifier(approval, ABSENT.approval);
}

/**
 * Normalize `auth.evidenceAnchor`. Absent / comment-only is omitted.
 * Anything else that is not `{ url, publicKey }` (or a test `{ submit,
 * publicKey }`) is invalid and refuses startup.
 *
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
export function normalizeEvidenceAnchor(raw) {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return invalid("evidenceAnchor");
  const entries = Object.entries(raw)
    .filter(([key]) => cleanKey(key));
  if (!entries.length) return null;
  const bag = new Map(entries);
  const publicKey = typeof bag.get("publicKey") === "string" ? bag.get("publicKey").trim() : "";
  if (!publicKey) return invalid("evidenceAnchor.publicKey");
  try {
    loadPinnedPublicKey(publicKey);
  } catch {
    return invalid("evidenceAnchor.publicKey");
  }
  const submit = bag.get("submit");
  if (typeof submit === "function") {
    return Object.freeze({
      publicKey,
      submit,
      timeoutMs: 2000,
    });
  }
  const url = typeof bag.get("url") === "string" ? bag.get("url").trim() : "";
  if (!url) return invalid("evidenceAnchor.url");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return invalid("evidenceAnchor.url");
  }
  if (parsed.protocol === "http:") {
    if (!isLoopbackUrl(url)) return invalid("evidenceAnchor.url");
  } else if (parsed.protocol !== "https:") {
    return invalid("evidenceAnchor.url");
  }
  const timeoutRaw = bag.get("timeoutMs");
  const timeoutMs = timeoutRaw === undefined
    ? 2000
    : (Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : null);
  if (timeoutMs === null) return invalid("evidenceAnchor.timeoutMs");
  return Object.freeze({ url, publicKey, timeoutMs });
}

/**
 * @param {object} [raw]
 * @returns {object}
 */
export function createExecutionChain(raw = {}) {
  const tenant = identifier(raw.tenant);
  const requestId = identifier(raw.requestId);
  const localExecutionId = identifier(raw.localExecutionId, requestId || ABSENT.localExecution);
  return Object.freeze({
    schema: "sentinel-execution-v1",
    tenant,
    identityId: identifier(raw.identityId),
    delegationId: identifier(raw.delegationId, ABSENT.delegation),
    decisionId: identifier(raw.decisionId),
    obligationId: identifier(raw.obligationId, ABSENT.obligations),
    approvalId: identifier(raw.approvalId, ABSENT.approval),
    localExecutionId,
    targetRevision: identifier(raw.targetRevision, ABSENT.targetRevision),
    receiptId: identifier(raw.receiptId),
    policyDigest: identifier(raw.policyDigest),
    outcome: typeof raw.outcome === "string" ? raw.outcome : null,
    requestId: requestId || (localExecutionId.startsWith("none:") ? "" : localExecutionId),
    receiptDecisionId: identifier(raw.receiptDecisionId),
    receiptTenant: identifier(raw.receiptTenant),
  });
}

/**
 * @param {object} chain
 * @returns {{state: string, reason: string|null}}
 */
export function reconcileExecution(chain) {
  if (!isRecord(chain)) {
    return { state: "incomplete", reason: "missing_identifier" };
  }
  const required = ["tenant", "identityId", "decisionId", "receiptId", "localExecutionId", "delegationId", "obligationId", "approvalId", "targetRevision"];
  const values = new Map(Object.entries(chain));
  if (required.some((key) => !identifier(values.get(key)))) {
    return { state: "incomplete", reason: "missing_identifier" };
  }
  if (chain.policyDigest && !POLICY_DIGEST.test(chain.policyDigest)) {
    return { state: "mismatched", reason: "policy_digest" };
  }
  if (chain.requestId && chain.localExecutionId && !chain.localExecutionId.startsWith("none:")
    && chain.requestId !== chain.localExecutionId) {
    return { state: "mismatched", reason: "execution_mismatch" };
  }
  if (chain.receiptDecisionId && chain.receiptDecisionId !== chain.decisionId) {
    return { state: "mismatched", reason: "decision_mismatch" };
  }
  if (chain.receiptTenant && chain.receiptTenant !== chain.tenant) {
    return { state: "mismatched", reason: "tenant_mismatch" };
  }
  return { state: "settled", reason: null };
}

/**
 * Minimized digest: the eight ids, tenant, policy digest, and outcome.
 * @param {object} chain
 * @returns {string}
 */
export function digestExecution(chain) {
  return digestPayload({
    identityId: chain.identityId,
    delegationId: chain.delegationId,
    decisionId: chain.decisionId,
    obligationId: chain.obligationId,
    approvalId: chain.approvalId,
    localExecutionId: chain.localExecutionId,
    targetRevision: chain.targetRevision,
    receiptId: chain.receiptId,
    tenant: chain.tenant,
    policyDigest: chain.policyDigest || "",
    outcome: chain.outcome || "",
  });
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Bounded in-process evidence ledger. Tenant-partitioned. Restart clears it.
 *
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.maxRecords]
 * @returns {object}
 */
export function createEvidenceLedger({
  now = () => Date.now(),
  maxRecords = DEFAULT_MAX_RECORDS,
} = {}) {
  const bound = positiveInt(maxRecords);
  if (bound === null) {
    throw new TypeError("createEvidenceLedger requires maxRecords to be a positive integer.");
  }
  const rows = [];
  let dropped = 0;

  return {
    get size() {
      return rows.length;
    },

    /**
     * @param {object} chain
     * @param {object|null} [inclusion]
     * @param {string|null} [publicPin]
     * @returns {object}
     */
    record(chain, inclusion = null, publicPin = null) {
      const frozenChain = createExecutionChain(chain);
      const reconciliation = reconcileExecution(frozenChain);
      const digest = digestExecution(frozenChain);
      let anchored = false;
      let verifiedInclusion = null;
      if (inclusion && publicPin) {
        const checked = verifyInclusion(publicPin, inclusion);
        anchored = checked.ok && inclusion.receiptDigest === digest;
        verifiedInclusion = anchored ? inclusion : null;
      }
      const row = Object.freeze({
        ...frozenChain,
        digest,
        reconciliation: Object.freeze(reconciliation),
        inclusion: verifiedInclusion,
        anchored,
        at: new Date(now()).toISOString(),
      });
      rows.push(row);
      if (rows.length > bound) {
        rows.shift();
        dropped += 1;
      }
      return row;
    },

    /** @returns {object[]} */
    records() {
      return rows.slice();
    },

    /**
     * @param {{tenant?: string|null}} [params]
     * @returns {object[]}
     */
    query({ tenant = null } = {}) {
      const tenantId = typeof tenant === "string" ? tenant.trim() : "";
      if (!tenantId) return [];
      return rows.filter((row) => row.tenant === tenantId);
    },

    /** @returns {{size: number, dropped: number, maxRecords: number}} */
    stats() {
      return { size: rows.length, dropped, maxRecords: bound };
    },
  };
}

const READ_DENIED = Object.freeze({ ok: false, reason: "not_entitled" });

/**
 * Tenant-scoped evidence read. Same grant rule as usage: tenant from
 * `auth.tenantGrants`; a `tenant` argument is a confirming hint.
 *
 * @param {object} params
 * @returns {{ok: true, tenant: string, records: object[]}|{ok: false, reason: "not_entitled"}}
 */
export function readEvidence({
  identity = null,
  tenantGrants = null,
  tenant = null,
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
  return { ok: true, tenant: resolved, records: ledger.query({ tenant: resolved }) };
}

function forbiddenKey(key) {
  return FORBIDDEN_EXPORT_KEYS.has(String(key).toLowerCase());
}

/**
 * Walk a value and fail if a forbidden key is present.
 * @param {*} value
 * @returns {boolean}
 */
export function isDataMinimized(value) {
  if (Array.isArray(value)) return value.every(isDataMinimized);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(([key, child]) => !forbiddenKey(key) && isDataMinimized(child));
}

function minimizeExecution(row) {
  return Object.freeze({
    identityId: row.identityId,
    delegationId: row.delegationId,
    decisionId: row.decisionId,
    obligationId: row.obligationId,
    approvalId: row.approvalId,
    localExecutionId: row.localExecutionId,
    targetRevision: row.targetRevision,
    receiptId: row.receiptId,
    policyDigest: row.policyDigest || null,
    outcome: row.outcome,
    reconcileState: row.reconciliation?.state ?? "incomplete",
    digest: row.digest,
    anchorId: row.inclusion?.anchorId ?? null,
    anchored: row.anchored === true,
  });
}

/**
 * Data-minimized assessor export bound to the live policy digest.
 *
 * @param {object} params
 * @param {object|null} params.identity
 * @param {object|null} params.tenantGrants
 * @param {string|null} [params.tenant]
 * @param {object|null} params.ledger
 * @param {string|null} [params.policyDigest] Live bound digest (server-resolved).
 * @param {boolean} [params.attested]
 * @param {() => Date} [params.now]
 * @returns {{ok: true, tenant: string, policyDigest: string|null, executions: object[], controls: object[]}|{ok: false, reason: string}}
 */
export function exportAssessor({
  identity = null,
  tenantGrants = null,
  tenant = null,
  ledger = null,
  policyDigest = null,
  attested = false,
  now = () => new Date(),
} = {}) {
  const read = readEvidence({ identity, tenantGrants, tenant, ledger });
  if (!read.ok) return read;
  const liveDigest = typeof policyDigest === "string" && POLICY_DIGEST.test(policyDigest)
    ? policyDigest.toLowerCase()
    : null;
  const executions = read.records.map(minimizeExecution);
  const evidenced = executions.find((row) => (
    row.anchored
    && row.reconcileState === "settled"
    && (!liveDigest || row.policyDigest === liveDigest)
  )) ?? null;

  const controls = ASSESSOR_CONTROL_CATALOG.map((control) => {
    const cites = Boolean(evidenced && control.source === "anchor");
    return Object.freeze({
      id: control.id,
      title: control.title,
      policyDigest: liveDigest,
      evidence: cites
        ? Object.freeze({
          receiptId: evidenced.receiptId,
          anchorId: evidenced.anchorId,
          digest: evidenced.digest,
        })
        : null,
      state: cites ? "evidenced" : "residual",
      reason: cites ? null : (evidenced ? "not_in_this_export" : "no_anchored_execution"),
    });
  });

  const pack = {
    ok: true,
    tenant: read.tenant,
    generatedAt: now().toISOString(),
    policyDigest: liveDigest,
    attested: attested === true && Boolean(liveDigest),
    executions,
    controls,
    residuals: Object.freeze([
      Object.freeze({
        id: "shared_host_notary",
        status: "managed",
        detail:
          "The lab notary may share a host with the edge. Production placement "
          + "must be a separately administered sink; this export does not choose one.",
      }),
      Object.freeze({
        id: "not_a_hosted_admission",
        status: "managed",
        detail:
          "Loopback evidence is not hosted design-partner admission. Onboard and "
          + "offboard remain later cuts.",
      }),
    ]),
  };
  if (!isDataMinimized(pack)) {
    throw new Error("Assessor export carried a forbidden key; the pack was not emitted.");
  }
  return pack;
}
