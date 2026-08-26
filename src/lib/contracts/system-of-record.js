/**
 * System-of-record adapter contract (#181).
 *
 * One adapter maps native operations onto portable action classes, proposes
 * an immutable manifest, evaluates it, and executes only after the typed
 * decision (and any required approval) allows it. A second adapter is out
 * of scope for this package.
 */

import { ContractError, REASON } from "./decisions.js";

/**
 * @typedef {Object} SystemOfRecordAdapter
 * @property {(proposal: object) => string} mapAction
 * @property {(proposal: object) => object} propose
 * @property {(manifest: object) => object} evaluate
 * @property {(manifest: object, decision: object, options?: object) => Promise<object>} execute
 */

/**
 * Consume a one-use approval when the decision requires it.
 *
 * @param {object} decision
 * @param {object} manifest
 * @param {{consume: Function}} [approval]
 * @param {string} [approvalId]
 * @param {string} [actor]
 * @returns {{blocked: boolean}}
 * @throws {ContractError}
 */
export function bindApprovalForExecute(decision, manifest, approval, approvalId, actor) {
  if (decision.result === "deny") return { blocked: true };
  if (decision.result !== "require_approval") return { blocked: false };
  if (!approval) {
    throw new ContractError("Approval required.", REASON.APPROVAL_REQUIRED);
  }
  approval.consume(approvalId, manifest.digest, actor);
  return { blocked: false };
}

/**
 * Compare declared effects with observed target state.
 *
 * @param {object|undefined} declared
 * @param {object|null|undefined} observed
 * @returns {{ok: boolean, reason?: string}}
 */
export function comparePostconditions(declared, observed) {
  if (!declared || typeof declared !== "object") return { ok: true };
  if (!observed || typeof observed !== "object") {
    return { ok: false, reason: REASON.POSTCONDITION };
  }
  const declaredMap = new Map(Object.entries(declared));
  const observedMap = new Map(Object.entries(observed));
  for (const [key, expected] of declaredMap.entries()) {
    if (observedMap.get(key) !== expected) {
      return { ok: false, reason: REASON.POSTCONDITION };
    }
  }
  return { ok: true };
}
