/**
 * Typed records at adapter-contract boundaries (#181).
 *
 * Identity, decision, and receipt are independently owned. They share ids
 * but an upstream identity or allow cannot become authority mid-flight.
 */

import { createHash, randomUUID } from "node:crypto";
import { ADAPTER_CONTRACT_VERSION } from "./version.js";
import { assertNoVendorFields } from "./decisions.js";

/** Portable action classes every system-of-record adapter must map onto. */
export const ACTION_CLASSES = Object.freeze([
  "bounded_read",
  "exfiltration_read",
  "reversible_write",
  "publish_or_destructive",
  "control_plane",
]);

const ACTION_CLASS_SET = new Set(ACTION_CLASSES);

/** Typed decision results. */
export const DECISION_RESULTS = Object.freeze([
  "deny",
  "allow",
  "allow_with_obligations",
  "require_approval",
]);

const DECISION_RESULT_SET = new Set(DECISION_RESULTS);

/** Assurance classes. Never presented as equivalent. */
export const ASSURANCE_CLASSES = Object.freeze([
  "source_enforced",
  "boundary_enforced",
  "advisory",
]);

const ASSURANCE_CLASS_SET = new Set(ASSURANCE_CLASSES);

const ACTION_CLASS_MAP = new Map(ACTION_CLASSES.map((name) => [name, name]));
const DECISION_RESULT_MAP = new Map(DECISION_RESULTS.map((name) => [name, name]));
const ASSURANCE_CLASS_MAP = new Map(ASSURANCE_CLASSES.map((name) => [name, name]));

/**
 * @param {string} value
 * @returns {string}
 */
export function assertActionClass(value) {
  if (!ACTION_CLASS_SET.has(value)) {
    throw new TypeError(`Unknown action class: ${String(value)}`);
  }
  return ACTION_CLASS_MAP.get(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
export function assertDecisionResult(value) {
  if (!DECISION_RESULT_SET.has(value)) {
    throw new TypeError(`Unknown decision result: ${String(value)}`);
  }
  return DECISION_RESULT_MAP.get(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
export function assertAssuranceClass(value) {
  if (!ASSURANCE_CLASS_SET.has(value)) {
    throw new TypeError(`Unknown assurance class: ${String(value)}`);
  }
  return ASSURANCE_CLASS_MAP.get(value);
}

/**
 * Canonical JSON for digesting a manifest. Key order is sorted.
 * @param {*} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(new Map(Object.entries(value)).get(key))}`)
    .join(",");
  return `{${body}}`;
}

/**
 * @param {object} payload
 * @returns {string}
 */
export function digestPayload(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/**
 * @param {object} [raw]
 * @returns {object}
 */
export function createIdentityContext(raw = {}) {
  assertNoVendorFields(raw);
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.map(String) : [];
  return Object.freeze({
    issuer: typeof raw.issuer === "string" ? raw.issuer : "local",
    subject: typeof raw.subject === "string"
      ? raw.subject
      : (typeof raw.sub === "string" ? raw.sub : "local-operator"),
    clientId: typeof raw.clientId === "string" ? raw.clientId : "local-operator",
    tenant: typeof raw.tenant === "string" ? raw.tenant : undefined,
    audience: typeof raw.audience === "string" ? raw.audience : undefined,
    scopes: Object.freeze(scopes),
    authTime: raw.authTime,
    tokenId: typeof raw.tokenId === "string" ? raw.tokenId : undefined,
    environment: typeof raw.environment === "string" ? raw.environment : undefined,
  });
}

/**
 * @param {{type: string, value?: string}} raw
 * @returns {{type: string, value?: string}}
 */
export function createObligation(raw) {
  if (!raw || typeof raw.type !== "string" || !raw.type.trim()) {
    throw new TypeError("Obligation requires a type");
  }
  return Object.freeze({ type: raw.type, value: raw.value });
}

/**
 * @param {object} raw
 * @returns {object}
 */
export function createDecisionRecord(raw) {
  assertNoVendorFields(raw);
  const result = assertDecisionResult(raw.result);
  const obligations = Array.isArray(raw.obligations)
    ? raw.obligations.map((item) => createObligation(item))
    : [];
  return Object.freeze({
    decisionId: raw.decisionId || randomUUID(),
    result,
    reason: raw.reason,
    reasons: Object.freeze(Array.isArray(raw.reasons) ? raw.reasons : (raw.reason ? [raw.reason] : [])),
    obligations: Object.freeze(obligations),
    actionDigest: raw.actionDigest,
    target: raw.target ? Object.freeze({ name: raw.target.name }) : undefined,
    actionClass: raw.actionClass ? assertActionClass(raw.actionClass) : undefined,
    policyDigest: raw.policyDigest,
    policyRevision: raw.policyRevision,
    evaluatorVersion: raw.evaluatorVersion || ADAPTER_CONTRACT_VERSION,
    expiresAt: raw.expiresAt,
    challenge: raw.challenge ? Object.freeze({ ...raw.challenge }) : undefined,
  });
}

/**
 * Build an immutable action manifest. The digest is always computed from
 * the canonical payload — a caller-supplied digest is ignored.
 *
 * @param {object} raw
 * @returns {object}
 */
export function createActionManifest(raw) {
  assertNoVendorFields(raw);
  const actionClass = assertActionClass(raw.actionClass);
  const attributes = raw.attributes && typeof raw.attributes === "object"
    ? { ...raw.attributes }
    : {};
  assertNoVendorFields(attributes);
  const expectedEffects = raw.expectedEffects && typeof raw.expectedEffects === "object"
    ? { ...raw.expectedEffects }
    : undefined;
  const target = raw.target && typeof raw.target === "object"
    ? Object.freeze({ name: raw.target.name, version: raw.target.version })
    : undefined;
  if (raw.hints) assertNoVendorFields(raw.hints);
  const digest = digestPayload({
    actionClass,
    operation: raw.operation,
    entityType: raw.entityType,
    bundle: raw.bundle,
    id: raw.id,
    attributes,
    expectedEffects,
    target,
    tenant: raw.tenant,
  });
  return Object.freeze({
    manifestId: raw.manifestId || randomUUID(),
    digest,
    contractVersion: raw.contractVersion || ADAPTER_CONTRACT_VERSION,
    actionClass,
    operation: raw.operation,
    entityType: raw.entityType,
    bundle: raw.bundle,
    id: raw.id,
    attributes: Object.freeze(attributes),
    expectedEffects: expectedEffects ? Object.freeze(expectedEffects) : undefined,
    target,
    tenant: raw.tenant,
    environment: raw.environment,
    expiry: raw.expiry,
    idempotencyKey: raw.idempotencyKey,
    hints: raw.hints ? Object.freeze({ ...raw.hints }) : undefined,
    filePath: raw.filePath,
    html: raw.html,
  });
}

/**
 * @param {object} raw
 * @returns {object}
 */
export function createExecutionReceipt(raw) {
  assertNoVendorFields(raw);
  const outcomes = new Set(["ok", "denied", "failed", "unknown", "pending"]);
  if (!outcomes.has(raw.outcome)) {
    throw new TypeError(`Unknown receipt outcome: ${String(raw.outcome)}`);
  }
  return Object.freeze({
    receiptId: raw.receiptId || randomUUID(),
    decisionId: raw.decisionId,
    outcome: raw.outcome,
    reason: raw.reason,
    nativeActor: raw.nativeActor,
    revisionId: raw.revisionId,
    before: raw.before,
    after: raw.after,
    declaredEffects: raw.declaredEffects,
    observed: raw.observed,
    occurredAt: raw.occurredAt || new Date().toISOString(),
  });
}
