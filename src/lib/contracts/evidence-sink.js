/**
 * Evidence-sink contract (#181).
 *
 * When policy or assurance class requires durable evidence, failure to write
 * it fails the governed action. Advisory writes may degrade.
 */

import { ContractError, REASON } from "./decisions.js";

/**
 * @typedef {Object} EvidenceSink
 * @property {(receipt: object) => void} writeRequired
 * @property {(receipt: object) => {ok: boolean, degraded?: boolean}} writeAdvisory
 */

/**
 * In-process evidence sink. `failRequired` makes every required write fail.
 * `failFinalRequired` fails only the post-mutation receipt (outcome other
 * than `pending`).
 *
 * @param {{failRequired?: boolean, failFinalRequired?: boolean}} [options]
 * @returns {EvidenceSink & {records: object[]}}
 */
export function createMemoryEvidenceSink({
  failRequired = false,
  failFinalRequired = false,
} = {}) {
  const records = [];

  return Object.freeze({
    records,
    /**
     * @param {object} receipt
     * @returns {void}
     */
    writeRequired(receipt) {
      if (failRequired || (failFinalRequired && receipt?.outcome !== "pending")) {
        throw new ContractError(
          "Required evidence write failed.",
          REASON.EVIDENCE_WRITE_FAILED,
        );
      }
      records.push({ required: true, receipt });
    },

    /**
     * @param {object} receipt
     * @returns {{ok: boolean}}
     */
    writeAdvisory(receipt) {
      records.push({ required: false, receipt });
      return { ok: true };
    },
  });
}

/**
 * Whether this action class must persist evidence at the given assurance.
 *
 * @param {string} actionClass
 * @param {string} assuranceClass
 * @returns {boolean}
 */
export function requiresEvidence(actionClass, assuranceClass) {
  if (assuranceClass === "advisory") return false;
  return actionClass === "publish_or_destructive" || actionClass === "control_plane";
}
