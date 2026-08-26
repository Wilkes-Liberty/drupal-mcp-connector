/**
 * Adapter-contract version and negotiation (#181).
 *
 * The family of evaluator / relay / approval / evidence-sink / system-of-record
 * contracts is versioned independently of the npm package and of the
 * connector↔Sentinel integration contract. Same major is compatible; a
 * different major is a hard miss.
 */

import { ContractError, REASON } from "./decisions.js";

/** Published adapter-contract version. */
export const ADAPTER_CONTRACT_VERSION = "1.0";

/** Policy revision label minted by this connector's local evaluator. */
export const ADAPTER_CONTRACT_POLICY_REVISION = "connector-local";

/**
 * @param {string|undefined|null} requested Requested contract version.
 * @returns {string} The version this process will speak.
 * @throws {ContractError} when the requested major is not this major.
 */
export function negotiateContractVersion(requested) {
  if (requested === undefined || requested === null || requested === "") {
    return ADAPTER_CONTRACT_VERSION;
  }
  if (typeof requested !== "string" || !isVersionString(requested)) {
    throw new ContractError(
      `Unsupported contract version request: ${String(requested)}`,
      REASON.INCOMPATIBLE_CONTRACT,
    );
  }
  const requestedMajor = requested.split(".")[0];
  const supportedMajor = ADAPTER_CONTRACT_VERSION.split(".")[0];
  if (requestedMajor !== supportedMajor) {
    throw new ContractError(
      `incompatible_contract_version: requested ${requested}, supported ${ADAPTER_CONTRACT_VERSION}`,
      REASON.INCOMPATIBLE_CONTRACT,
    );
  }
  return ADAPTER_CONTRACT_VERSION;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isVersionString(value) {
  const parts = value.split(".");
  if (!parts.length) return false;
  return parts.every((part) => part.length > 0 && /^[0-9]+$/.test(part));
}
