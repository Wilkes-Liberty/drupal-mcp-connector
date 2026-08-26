/**
 * Typed decisions, stable reason codes, and the narrowing compose rule (#181).
 *
 * An upstream allow cannot widen a local or target deny. Obligations union
 * only when both sides allow. Model and agent vendor keys are not part of
 * any contract record.
 */

/** Stable contract-level reason codes. Do not invent a parallel set. */
export const REASON = Object.freeze({
  POLICY_DENIED: "policy_denied",
  TARGET_DENIED: "target_denied",
  TENANT_ESCAPE: "tenant_escape",
  HOSTILE_INPUT: "hostile_input",
  EVIDENCE_WRITE_FAILED: "evidence_write_failed",
  REPLAY: "replay_detected",
  POSTCONDITION: "postcondition_discrepancy",
  APPROVAL_REQUIRED: "approval_required",
  INCOMPATIBLE_CONTRACT: "incompatible_contract_version",
  VENDOR_FIELD: "vendor_field_rejected",
});

/** Keys that name a model or agent vendor. They stay outside the contract. */
export const VENDOR_FIELD_NAMES = Object.freeze([
  "model",
  "modelVendor",
  "agentVendor",
  "agentFramework",
  "llmProvider",
  "openai",
  "anthropic",
  "vendor",
]);

const VENDOR_FIELD_SET = new Set(VENDOR_FIELD_NAMES);

/**
 * Decision / proposal error that carries a stable reason code.
 */
export class ContractError extends Error {
  /**
   * @param {string} message Operator-facing description (no secrets).
   * @param {string} reason Stable machine reason.
   */
  constructor(message, reason) {
    super(message);
    this.name = "ContractError";
    this.reason = reason;
  }
}

/**
 * Reject records that carry a model or agent vendor key.
 *
 * @param {object} record Candidate identity, proposal, or manifest.
 * @returns {void}
 * @throws {ContractError}
 */
export function assertNoVendorFields(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return;
  }
  const keys = Object.keys(record);
  for (const key of keys) {
    if (VENDOR_FIELD_SET.has(key)) {
      throw new ContractError(
        "Model and agent vendor fields are outside the adapter contract.",
        REASON.VENDOR_FIELD,
      );
    }
  }
}

/**
 * @param {Array<{type: string, value?: string}>} left
 * @param {Array<{type: string, value?: string}>} right
 * @returns {Array<{type: string, value?: string}>}
 */
export function unionObligations(left = [], right = []) {
  const seen = new Set();
  const out = [];
  for (const item of [...left, ...right]) {
    if (!item || typeof item.type !== "string") continue;
    const key = `${item.type}:${item.value ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.freeze({ type: item.type, value: item.value }));
  }
  return out;
}

const RESULT_RANK = new Map([
  ["deny", 0],
  ["require_approval", 1],
  ["allow_with_obligations", 2],
  ["allow", 3],
]);

/**
 * Compose an optional upstream decision with the local / target decision.
 * Local deny is authoritative. Upstream allow never widens a local deny.
 *
 * @param {object|null|undefined} upstream Upstream evaluator decision.
 * @param {object} local Local / target-side decision.
 * @returns {object} Frozen composed decision.
 */
export function composeDecisions(upstream, local) {
  if (!upstream) return local;
  if (local.result === "deny") return local;
  if (upstream.result === "deny") return upstream;

  const localRank = RESULT_RANK.get(local.result) ?? 0;
  const upstreamRank = RESULT_RANK.get(upstream.result) ?? 0;
  const narrower = localRank <= upstreamRank ? local : upstream;
  const obligations = unionObligations(upstream.obligations, local.obligations);

  if (narrower.result === "require_approval") {
    return Object.freeze({
      ...narrower,
      result: "require_approval",
      obligations: Object.freeze(obligations),
    });
  }

  if (obligations.length > 0 || narrower.result === "allow_with_obligations") {
    return Object.freeze({
      ...local,
      result: "allow_with_obligations",
      reason: local.reason,
      obligations: Object.freeze(obligations),
    });
  }

  return Object.freeze({
    ...local,
    result: "allow",
    obligations: Object.freeze([]),
  });
}
