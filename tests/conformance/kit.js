/**
 * Adapter-agnostic conformance runners (#181).
 *
 * A second system-of-record adapter would call these same cases. This package
 * registers only Drupal.
 */

import { expect } from "vitest";
import {
  DECISION_RESULTS,
  REASON,
  VENDOR_FIELD_NAMES,
} from "../../src/lib/contracts/index.js";

/**
 * @param {object} decision
 * @returns {void}
 */
export function assertTypedDecision(decision) {
  expect(decision).toEqual(expect.objectContaining({
    decisionId: expect.any(String),
    result: expect.any(String),
    evaluatorVersion: expect.any(String),
  }));
  expect(DECISION_RESULTS).toContain(decision.result);
  expect(Array.isArray(decision.obligations)).toBe(true);
  expect(Array.isArray(decision.reasons)).toBe(true);
  if (decision.result !== "allow" || decision.reason) {
    expect(typeof decision.reason === "string" || decision.reason === undefined).toBe(true);
  }
  for (const key of VENDOR_FIELD_NAMES) {
    expect(decision).not.toHaveProperty(key);
  }
}

/**
 * @param {object} receipt
 * @returns {void}
 */
export function assertExecutionReceipt(receipt) {
  expect(receipt).toEqual(expect.objectContaining({
    receiptId: expect.any(String),
    outcome: expect.any(String),
    occurredAt: expect.any(String),
  }));
  expect(["ok", "denied", "failed", "unknown", "pending"]).toContain(receipt.outcome);
  for (const key of VENDOR_FIELD_NAMES) {
    expect(receipt).not.toHaveProperty(key);
  }
}

/**
 * @param {object} adapter
 * @param {object} proposal
 * @returns {{manifest: object, decision: object}}
 */
export function runEvaluate(adapter, proposal) {
  const manifest = adapter.propose(proposal);
  expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(manifest.actionClass).toEqual(expect.any(String));
  const decision = adapter.evaluate(manifest);
  assertTypedDecision(decision);
  expect(decision.actionDigest).toBe(manifest.digest);
  return { manifest, decision };
}

/**
 * @param {object} adapter
 * @param {object} proposal
 * @returns {{manifest: object, decision: object}}
 */
export function caseAllowedAction(adapter, proposal) {
  const result = runEvaluate(adapter, proposal);
  expect(["allow", "allow_with_obligations", "require_approval"]).toContain(result.decision.result);
  return result;
}

/**
 * @param {object} adapter
 * @param {object} proposal
 * @param {string} [reason]
 * @returns {{manifest: object, decision: object}}
 */
export function caseDeniedAction(adapter, proposal, reason) {
  const result = runEvaluate(adapter, proposal);
  expect(result.decision.result).toBe("deny");
  if (reason) expect(result.decision.reason).toBe(reason);
  return result;
}

/**
 * @param {object} adapter
 * @param {object} proposal
 * @returns {void}
 */
export function caseHostileVendorField(adapter, proposal) {
  expect(() => adapter.propose(proposal)).toThrow();
}

/**
 * @param {object} adapter
 * @param {object} proposal
 * @returns {{manifest: object, decision: object}}
 */
export function caseHostileModality(adapter, proposal) {
  return caseDeniedAction(adapter, proposal, REASON.HOSTILE_INPUT);
}

/**
 * @param {object} adapter
 * @param {object} proposal
 * @returns {{manifest: object, decision: object}}
 */
export function caseTenantEscape(adapter, proposal) {
  return caseDeniedAction(adapter, proposal, REASON.TENANT_ESCAPE);
}

/**
 * @param {object} adapter
 * @param {object} proposal
 * @param {{approvalId?: string}} [execOptions]
 * @returns {Promise<{manifest: object, decision: object, receipt: object}>}
 */
export async function caseEvidenceWriteFailure(adapter, proposal, execOptions = {}) {
  const { manifest, decision } = runEvaluate(adapter, proposal);
  const issued = decision.result === "require_approval"
    ? adapter.approval.issue(manifest, "agent-1")
    : null;
  const receipt = await adapter.execute(manifest, decision, {
    approvalId: execOptions.approvalId ?? issued?.approvalId,
  });
  assertExecutionReceipt(receipt);
  expect(receipt.outcome).toBe("failed");
  expect(receipt.reason).toBe(REASON.EVIDENCE_WRITE_FAILED);
  expect(adapter.backend.store.size).toBe(0);
  return { manifest, decision, receipt };
}

/**
 * @param {object} adapter
 * @param {object} proposal
 * @returns {Promise<{first: object, second: object}>}
 */
export async function caseReplay(adapter, proposal) {
  const { manifest, decision } = runEvaluate(adapter, proposal);
  expect(decision.result).toBe("require_approval");
  const issued = adapter.approval.issue(manifest, "agent-1");
  const first = await adapter.execute(manifest, decision, { approvalId: issued.approvalId });
  assertExecutionReceipt(first);
  const second = await adapter.execute(manifest, decision, { approvalId: issued.approvalId });
  assertExecutionReceipt(second);
  expect(second.outcome).toBe("failed");
  expect(second.reason).toBe(REASON.REPLAY);
  return { first, second };
}

/**
 * @param {object} adapter
 * @param {object} proposal
 * @returns {Promise<{manifest: object, decision: object, receipt: object}>}
 */
export async function casePostconditionDiscrepancy(adapter, proposal) {
  const { manifest, decision } = runEvaluate(adapter, proposal);
  let approvalId;
  if (decision.result === "require_approval") {
    approvalId = adapter.approval.issue(manifest, "agent-1").approvalId;
  }
  const receipt = await adapter.execute(manifest, decision, { approvalId });
  assertExecutionReceipt(receipt);
  expect(receipt.outcome).toBe("unknown");
  expect(receipt.reason).toBe(REASON.POSTCONDITION);
  return { manifest, decision, receipt };
}
