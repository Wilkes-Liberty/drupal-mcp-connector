/**
 * Public adapter-contract surface (#181).
 *
 * Provider-neutral evaluator, relay, approval, evidence-sink, and
 * system-of-record contracts, plus the Drupal reference adapter. Model and
 * agent vendors are not part of this module.
 */

export {
  ADAPTER_CONTRACT_POLICY_REVISION,
  ADAPTER_CONTRACT_VERSION,
  negotiateContractVersion,
} from "./version.js";

export {
  ACTION_CLASSES,
  ASSURANCE_CLASSES,
  DECISION_RESULTS,
  assertActionClass,
  assertAssuranceClass,
  assertDecisionResult,
  createActionManifest,
  createDecisionRecord,
  createExecutionReceipt,
  createIdentityContext,
  createObligation,
  digestPayload,
  stableStringify,
} from "./types.js";

export {
  ContractError,
  REASON,
  VENDOR_FIELD_NAMES,
  assertNoVendorFields,
  composeDecisions,
  unionObligations,
} from "./decisions.js";

export { createEvaluator } from "./evaluator.js";
export { createLocalRelay } from "./relay.js";
export { createMemoryApproval } from "./approval.js";
export { createMemoryEvidenceSink, requiresEvidence } from "./evidence-sink.js";
export { bindApprovalForExecute, comparePostconditions } from "./system-of-record.js";
export { createMemoryBackend } from "./fixtures.js";
export { createDrupalAdapter, mapDrupalAction } from "./drupal.js";
