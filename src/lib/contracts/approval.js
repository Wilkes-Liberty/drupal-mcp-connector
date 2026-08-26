/**
 * Approval-interface contract (#181).
 *
 * An approval binds to an action-manifest digest and a single actor. It is
 * one-use. Replay, digest mismatch, or actor mismatch invalidate it.
 */

import { randomUUID } from "node:crypto";
import { ContractError, REASON } from "./decisions.js";

/**
 * @typedef {Object} ApprovalInterface
 * @property {(manifest: object, actor?: string) => {approvalId: string, digest: string}} issue
 * @property {(approvalId: string, digest: string, actor?: string) => {approvalId: string, digest: string}} consume
 */

/**
 * In-process one-use approval ledger.
 * @returns {ApprovalInterface & {size: () => number}}
 */
export function createMemoryApproval() {
  const store = new Map();

  return Object.freeze({
    /**
     * @param {object} manifest
     * @param {string} [actor]
     * @returns {{approvalId: string, digest: string}}
     */
    issue(manifest, actor) {
      if (!manifest?.digest) {
        throw new ContractError("Approval requires a manifest digest.", REASON.APPROVAL_REQUIRED);
      }
      const approvalId = randomUUID();
      store.set(approvalId, {
        digest: manifest.digest,
        actor: actor ?? null,
        used: false,
      });
      return { approvalId, digest: manifest.digest };
    },

    /**
     * @param {string} approvalId
     * @param {string} digest
     * @param {string} [actor]
     * @returns {{approvalId: string, digest: string}}
     */
    consume(approvalId, digest, actor) {
      if (!approvalId) {
        throw new ContractError("Approval required.", REASON.APPROVAL_REQUIRED);
      }
      const entry = store.get(approvalId);
      if (!entry || entry.used) {
        throw new ContractError("Approval already used or unknown.", REASON.REPLAY);
      }
      if (entry.digest !== digest) {
        throw new ContractError("Approval digest mismatch.", REASON.REPLAY);
      }
      if (entry.actor && entry.actor !== actor) {
        throw new ContractError("Approval actor mismatch.", REASON.REPLAY);
      }
      store.set(approvalId, { ...entry, used: true });
      return { approvalId, digest };
    },

    /** @returns {number} */
    size() {
      return store.size;
    },
  });
}
