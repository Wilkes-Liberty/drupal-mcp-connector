/**
 * Policy-evaluator contract (#181).
 *
 * An evaluator returns a typed DecisionRecord. It does not execute. Callers
 * compose upstream and local decisions with composeDecisions — never by
 * trusting an upstream allow as authority.
 */

/**
 * @typedef {Object} PolicyEvaluator
 * @property {(manifest: object, identity: object) => object} evaluate
 */

/**
 * Wrap a function as a PolicyEvaluator.
 * @param {(manifest: object, identity: object) => object} evaluateFn
 * @returns {PolicyEvaluator}
 */
export function createEvaluator(evaluateFn) {
  if (typeof evaluateFn !== "function") {
    throw new TypeError("createEvaluator requires an evaluate function");
  }
  return Object.freeze({
    evaluate(manifest, identity) {
      return evaluateFn(manifest, identity);
    },
  });
}
