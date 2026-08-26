/**
 * Drupal system-of-record adapter (#181).
 *
 * Wraps the connector's existing security, principal, and (injected) backend
 * seams so the published contracts can be proven against Drupal without a
 * second adapter and without rewriting MCP tool dispatch.
 */

import { randomUUID } from "node:crypto";
import {
  DEFAULT_SECURITY_PRESET,
  SecurityError,
  assertConfigWriteAllowed,
  assertDeleteAllowed,
  assertPublishAllowed,
  assertReadAllowed,
  assertWriteAllowed,
  isPublishBearing,
  resolveSecurityConfig,
} from "../security.js";
import { createMemoryApproval } from "./approval.js";
import { composeDecisions, ContractError, REASON } from "./decisions.js";
import { createMemoryEvidenceSink, requiresEvidence } from "./evidence-sink.js";
import { createMemoryBackend } from "./fixtures.js";
import { createLocalRelay, hintTargetName } from "./relay.js";
import { bindApprovalForExecute, comparePostconditions } from "./system-of-record.js";
import {
  DECISION_RESULTS,
  createActionManifest,
  createDecisionRecord,
  createExecutionReceipt,
  createIdentityContext,
} from "./types.js";
import {
  ADAPTER_CONTRACT_POLICY_REVISION,
  ADAPTER_CONTRACT_VERSION,
  negotiateContractVersion,
} from "./version.js";

const CONTROL_ENTITY_TYPES = new Set([
  "user_role",
  "oauth2_token",
  "key",
  "consumer",
  "encryption_profile",
  "mcp_tool_config",
  "mcp_policy_profile",
]);

const HOSTILE_HTML = /<\s*script\b|javascript\s*:|on(error|load|click)\s*=/i;

/**
 * @param {object} [options]
 * @returns {import("./system-of-record.js").SystemOfRecordAdapter}
 */
export function createDrupalAdapter(options = {}) {
  const sites = Array.isArray(options.sites)
    ? options.sites
    : (options.site ? [options.site] : []);
  const defaultSite = options.site ?? sites[0];
  const identity = options.identity
    ? createIdentityContext(options.identity)
    : null;
  const backend = options.backend ?? createMemoryBackend();
  const approval = options.approval ?? createMemoryApproval();
  const evidence = options.evidence ?? createMemoryEvidenceSink();
  const relay = options.relay ?? createLocalRelay({
    sites,
    grants: options.grants ?? null,
    defaultSite: defaultSite?._name,
  });
  const upstreamEvaluator = options.upstreamEvaluator ?? null;
  const assuranceClass = options.assuranceClass ?? "boundary_enforced";

  return Object.freeze({
    contractVersion: ADAPTER_CONTRACT_VERSION,
    approval,
    evidence,
    backend,
    relay,

    /**
     * @param {object} proposal
     * @returns {string}
     */
    mapAction(proposal) {
      return mapDrupalAction(proposal);
    },

    /**
     * @param {object} proposal
     * @returns {object}
     */
    propose(proposal) {
      negotiateContractVersion(proposal?.contractVersion);
      return createActionManifest({
        ...proposal,
        actionClass: mapDrupalAction(proposal),
        contractVersion: ADAPTER_CONTRACT_VERSION,
        target: proposal.target ?? {
          name: hintTargetName(proposal.hints) ?? defaultSite?._name,
        },
      });
    },

    /**
     * @param {object} manifest
     * @returns {object}
     */
    evaluate(manifest) {
      negotiateContractVersion(manifest.contractVersion);
      const local = evaluateLocal(manifest, {
        identity,
        relay,
        defaultSite,
        sites,
      });
      const upstream = upstreamEvaluator
        ? upstreamEvaluator.evaluate(manifest, identity)
        : null;
      return composeDecisions(upstream, local);
    },

    /**
     * Execute only after a fresh evaluation. A caller allow cannot widen
     * a local deny or skip required approval. `decision.decisionId` is
     * kept on the receipt when present.
     *
     * @param {object} manifest
     * @param {object} [decision]
     * @param {{approvalId?: string}} [execOptions]
     * @returns {Promise<object>}
     */
    async execute(manifest, decision = {}, execOptions = {}) {
      if (decision.actionDigest && decision.actionDigest !== manifest.digest) {
        return createExecutionReceipt({
          decisionId: decision.decisionId,
          outcome: "failed",
          reason: REASON.REPLAY,
        });
      }

      const local = this.evaluate(manifest);
      const caller = typedCallerDecision(decision);
      const authoritative = composeDecisions(caller, local);
      const decisionId = decision.decisionId ?? authoritative.decisionId;

      if (authoritative.result === "deny") {
        return createExecutionReceipt({
          decisionId,
          outcome: "denied",
          reason: authoritative.reason,
        });
      }

      try {
        bindApprovalForExecute(
          authoritative,
          manifest,
          approval,
          execOptions.approvalId,
          identity?.subject,
        );
      } catch (err) {
        return createExecutionReceipt({
          decisionId,
          outcome: "failed",
          reason: err instanceof ContractError ? err.reason : REASON.APPROVAL_REQUIRED,
        });
      }

      const needsEvidence = requiresEvidence(manifest.actionClass, assuranceClass);
      if (needsEvidence) {
        try {
          evidence.writeRequired(createExecutionReceipt({
            decisionId,
            outcome: "pending",
          }));
        } catch (err) {
          return createExecutionReceipt({
            decisionId,
            outcome: "failed",
            reason: err instanceof ContractError ? err.reason : REASON.EVIDENCE_WRITE_FAILED,
          });
        }
      }

      const snapshot = typeof backend.captureState === "function"
        ? await backend.captureState()
        : null;

      const written = await applyBackend(backend, manifest);
      const observed = written
        ? await backend.getEntity({
          id: written.id,
          entityType: manifest.entityType,
          bundle: manifest.bundle,
        }) ?? written
        : null;
      const declared = declaredEffects(manifest);
      const post = comparePostconditions(declared, flattenObserved(observed));
      const receipt = createExecutionReceipt({
        decisionId,
        outcome: post.ok ? "ok" : "unknown",
        reason: post.ok ? undefined : post.reason,
        nativeActor: identity?.subject ?? "local-operator",
        revisionId: observed?.id,
        after: observed,
        declaredEffects: declared,
        observed: flattenObserved(observed),
      });

      if (needsEvidence) {
        try {
          evidence.writeRequired(receipt);
        } catch (err) {
          await restoreBackend(backend, snapshot);
          return createExecutionReceipt({
            ...receipt,
            receiptId: randomUUID(),
            outcome: "failed",
            reason: err instanceof ContractError ? err.reason : REASON.EVIDENCE_WRITE_FAILED,
          });
        }
      } else {
        evidence.writeAdvisory(receipt);
      }

      return receipt;
    },
  });
}

/**
 * @param {object} proposal
 * @returns {string}
 */
export function mapDrupalAction(proposal = {}) {
  const operation = String(proposal.operation ?? "read");
  const entityType = String(proposal.entityType ?? "");
  if (
    operation === "config"
    || operation === "config_set"
    || operation === "config_get"
    || CONTROL_ENTITY_TYPES.has(entityType)
  ) {
    return "control_plane";
  }
  if (operation === "delete" || operation === "publish" || isPublishBearing(proposal.attributes)) {
    return "publish_or_destructive";
  }
  if (operation === "list" || operation === "export") {
    return "exfiltration_read";
  }
  if (operation === "create" || operation === "update") {
    return "reversible_write";
  }
  return "bounded_read";
}

/**
 * @param {object} manifest
 * @param {object} ctx
 * @returns {object}
 */
function evaluateLocal(manifest, ctx) {
  const base = {
    actionDigest: manifest.digest,
    actionClass: manifest.actionClass,
    policyDigest: policyDigestFor(ctx.defaultSite),
    policyRevision: ADAPTER_CONTRACT_POLICY_REVISION,
    evaluatorVersion: ADAPTER_CONTRACT_VERSION,
  };

  const hostile = detectHostileInput(manifest);
  if (hostile) {
    return deny(base, hostile, manifest.target);
  }

  let resolved;
  try {
    resolved = ctx.relay.resolve(ctx.identity, manifest.hints ?? {});
  } catch (err) {
    const reason = err instanceof ContractError ? err.reason : REASON.TENANT_ESCAPE;
    return deny(base, reason, manifest.target);
  }

  const site = resolved.site;
  const evaluated = {
    ...base,
    policyDigest: policyDigestFor(site),
  };
  const sec = resolveSecurityConfig(site);
  const scope = requiredScope(manifest);
  if (ctx.identity && scope && !ctx.identity.scopes.includes(scope)) {
    return deny(evaluated, REASON.POLICY_DENIED, resolved, {
      type: "scope",
      scope,
    });
  }

  try {
    applySecurityGates(sec, manifest);
  } catch (err) {
    const reason = err instanceof SecurityError ? REASON.TARGET_DENIED : REASON.POLICY_DENIED;
    return deny(evaluated, reason, resolved);
  }

  if (manifest.actionClass === "publish_or_destructive" || manifest.actionClass === "control_plane") {
    const writeLike = manifest.operation !== "config_get" && manifest.operation !== "read";
    if (writeLike) {
      return createDecisionRecord({
        ...evaluated,
        result: "require_approval",
        reason: REASON.APPROVAL_REQUIRED,
        target: { name: resolved.name },
      });
    }
  }

  if (manifest.actionClass === "exfiltration_read") {
    return createDecisionRecord({
      ...evaluated,
      result: "allow_with_obligations",
      reason: "read_budget",
      obligations: [{ type: "read_budget" }],
      target: { name: resolved.name },
    });
  }

  return createDecisionRecord({
    ...evaluated,
    result: "allow",
    reason: "allow",
    target: { name: resolved.name },
  });
}

/**
 * @param {object} sec
 * @param {object} manifest
 * @returns {void}
 */
function applySecurityGates(sec, manifest) {
  const entityType = manifest.entityType;
  const bundle = manifest.bundle;
  const operation = manifest.operation;

  if (operation === "config" || operation === "config_set") {
    assertConfigWriteAllowed(sec);
    return;
  }
  if (operation === "config_get") {
    return;
  }
  if (operation === "delete") {
    assertDeleteAllowed(sec, entityType, bundle, manifest.id ?? "");
    return;
  }
  if (operation === "create" || operation === "update" || operation === "publish") {
    assertWriteAllowed(sec, operation === "publish" ? "update" : operation, entityType, bundle);
    assertPublishAllowed(sec, manifest.attributes ?? {});
    return;
  }
  if (operation === "list" || operation === "export" || operation === "read") {
    if (entityType) assertReadAllowed(sec, entityType, bundle);
  }
}

/**
 * @param {object} manifest
 * @returns {string|null}
 */
function detectHostileInput(manifest) {
  const html = collectHtml(manifest);
  if (html && HOSTILE_HTML.test(html)) return REASON.HOSTILE_INPUT;
  if (manifest.filePath && isEscapingPath(manifest.filePath)) return REASON.HOSTILE_INPUT;
  return null;
}

/**
 * @param {object} manifest
 * @returns {string}
 */
function collectHtml(manifest) {
  if (typeof manifest.html === "string") return manifest.html;
  const body = manifest.attributes?.body;
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && typeof body.value === "string") return body.value;
  return "";
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isEscapingPath(filePath) {
  const normalized = String(filePath).split("\\").join("/");
  if (normalized.includes("..")) return true;
  if (normalized.includes("/.ssh/") || normalized.endsWith("/.ssh")) return true;
  if (normalized.includes("/.env") || normalized.split("/").pop()?.startsWith(".env")) return true;
  if (normalized.startsWith("/etc/") || normalized === "/etc/passwd") return true;
  return false;
}

/**
 * @param {object} manifest
 * @returns {string|null}
 */
function requiredScope(manifest) {
  if (manifest.actionClass === "control_plane") return "mcp_config";
  if (
    manifest.actionClass === "reversible_write"
    || manifest.actionClass === "publish_or_destructive"
  ) {
    return "mcp_write";
  }
  return "mcp_read";
}

/**
 * @param {object} site
 * @returns {string}
 */
function policyDigestFor(site) {
  const preset = site?.security?.preset ?? DEFAULT_SECURITY_PRESET;
  return `${preset}:${ADAPTER_CONTRACT_POLICY_REVISION}`;
}

/**
 * @param {object} base
 * @param {string} reason
 * @param {object} [target]
 * @param {object} [challenge]
 * @returns {object}
 */
function deny(base, reason, target, challenge) {
  return createDecisionRecord({
    ...base,
    result: "deny",
    reason,
    reasons: [reason],
    target: target?.name ? { name: target.name } : target,
    challenge,
  });
}

/**
 * @param {object} [decision]
 * @returns {object|null}
 */
function typedCallerDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  if (!DECISION_RESULTS.includes(decision.result)) return null;
  return decision;
}

/**
 * @param {object} backend
 * @param {*} snapshot
 * @returns {Promise<void>}
 */
async function restoreBackend(backend, snapshot) {
  if (snapshot === undefined || snapshot === null || typeof backend.restoreState !== "function") {
    return;
  }
  await backend.restoreState(snapshot);
}

/**
 * @param {object} backend
 * @param {object} manifest
 * @returns {Promise<object|null>}
 */
async function applyBackend(backend, manifest) {
  const ref = {
    entityType: manifest.entityType,
    bundle: manifest.bundle,
    id: manifest.id,
    attributes: { ...(manifest.attributes ?? {}) },
  };
  if (manifest.operation === "delete") {
    await backend.deleteEntity(ref);
    return { id: manifest.id, deleted: true };
  }
  if (manifest.operation === "create" || manifest.operation === "publish") {
    if (manifest.operation === "publish") ref.attributes.status = true;
    if (manifest.operation === "publish" && manifest.id) {
      return backend.updateEntity(ref);
    }
    return backend.createEntity(ref);
  }
  if (manifest.operation === "update") {
    return backend.updateEntity(ref);
  }
  if (manifest.id) {
    return backend.getEntity(ref);
  }
  return null;
}

/**
 * @param {object} manifest
 * @returns {object|undefined}
 */
function declaredEffects(manifest) {
  if (manifest.expectedEffects) return { ...manifest.expectedEffects };
  if (manifest.attributes && manifest.attributes.status !== undefined) {
    return { status: manifest.attributes.status };
  }
  return undefined;
}

/**
 * @param {object|null} entity
 * @returns {object|undefined}
 */
function flattenObserved(entity) {
  if (!entity) return undefined;
  return {
    id: entity.id,
    status: entity.status ?? entity.attributes?.status,
    deleted: entity.deleted,
  };
}
