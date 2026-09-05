/**
 * Independently verifiable evidence (#261) — pure rules.
 *
 * The eight identifiers reconcile or they do not. Cross-tenant reads are
 * denied before a record is looked at. The assessor cites the live policy
 * digest and evidence ids; it never writes "passed". Forbidden payload
 * keys cannot enter the export.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNotary, generateNotaryKeys, pinPublicKey } from "../../src/lib/anchor.js";
import {
  ABSENT,
  ASSESSOR_CONTROL_CATALOG,
  createEvidenceLedger,
  createExecutionChain,
  digestExecution,
  exportAssessor,
  identityId,
  isDataMinimized,
  normalizeEvidenceAnchor,
  obligationId,
  readEvidence,
  reconcileExecution,
} from "../../src/lib/evidence.js";

const POLICY = "ab".repeat(32);
const TENANT_GRANTS = { "client-a": ["tenant-a"], "client-b": ["tenant-b"] };

function chain(overrides = {}) {
  return {
    tenant: "tenant-a",
    identityId: "id-a",
    delegationId: ABSENT.delegation,
    decisionId: "dec-1",
    obligationId: ABSENT.obligations,
    approvalId: ABSENT.approval,
    localExecutionId: "req-1",
    targetRevision: "rev-1",
    receiptId: "rcpt-1",
    policyDigest: POLICY,
    outcome: "ok",
    requestId: "req-1",
    receiptDecisionId: "dec-1",
    receiptTenant: "tenant-a",
    ...overrides,
  };
}

describe("identity and obligation identifiers", () => {
  it("digests issuer, subject, and client and never a token", () => {
    const id = identityId({ iss: "https://idp.test", sub: "sub-a", clientId: "client-a" });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(identityId({
      iss: "https://idp.test",
      sub: "sub-a",
      clientId: "client-a",
      access_token: "secret",
    })).toBe(id);
    expect(identityId({ tenant: "spoof" })).toBe("");
    expect(obligationId([])).toBe(ABSENT.obligations);
    expect(obligationId([{ type: "retain" }])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("reconcileExecution", () => {
  it("settles when the eight identifiers agree", () => {
    expect(reconcileExecution(createExecutionChain(chain()))).toEqual({
      state: "settled",
      reason: null,
    });
  });

  it("names incomplete and mismatched chains instead of succeeding", () => {
    expect(reconcileExecution(createExecutionChain(chain({ decisionId: "" }))))
      .toEqual({ state: "incomplete", reason: "missing_identifier" });
    expect(reconcileExecution(createExecutionChain(chain({ receiptDecisionId: "other" }))))
      .toEqual({ state: "mismatched", reason: "decision_mismatch" });
    expect(reconcileExecution(createExecutionChain(chain({ receiptTenant: "tenant-b" }))))
      .toEqual({ state: "mismatched", reason: "tenant_mismatch" });
    expect(reconcileExecution(createExecutionChain(chain({ localExecutionId: "other" }))))
      .toEqual({ state: "mismatched", reason: "execution_mismatch" });
  });

  it("treats explicit none: absences as identifiers, not gaps", () => {
    const denied = createExecutionChain(chain({
      localExecutionId: ABSENT.localExecution,
      targetRevision: ABSENT.targetRevision,
      requestId: "",
    }));
    expect(denied.localExecutionId).toBe(ABSENT.localExecution);
    expect(reconcileExecution(denied).state).toBe("settled");
  });
});

describe("normalizeEvidenceAnchor", () => {
  const keys = generateNotaryKeys();

  it("omits an absent or comment-only table and refuses an unreadable one", () => {
    expect(normalizeEvidenceAnchor(null)).toBeNull();
    expect(normalizeEvidenceAnchor({ _comment: "later" })).toBeNull();
    expect(normalizeEvidenceAnchor("https://anchor.test")).toMatchObject({
      invalid: true,
      reason: "evidenceAnchor",
    });
    expect(normalizeEvidenceAnchor({ url: "https://anchor.test" })).toMatchObject({
      invalid: true,
      reason: "evidenceAnchor.publicKey",
    });
    expect(normalizeEvidenceAnchor({
      url: "http://anchor.test",
      publicKey: keys.publicPin,
    })).toMatchObject({ invalid: true, reason: "evidenceAnchor.url" });
    expect(normalizeEvidenceAnchor({
      url: "https://anchor.test",
      publicKey: keys.publicPin,
    })).toMatchObject({ url: "https://anchor.test", publicKey: keys.publicPin });
    expect(normalizeEvidenceAnchor({
      url: "http://127.0.0.1:9",
      publicKey: keys.publicPin,
    }).url).toBe("http://127.0.0.1:9");
  });

  it("refuses a parseable SPKI that is not Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(normalizeEvidenceAnchor({
      url: "https://anchor.test",
      publicKey: pinPublicKey(rsa.publicKey),
    })).toMatchObject({ invalid: true, reason: "evidenceAnchor.publicKey" });
  });
});

describe("ledger, read, and assessor export", () => {
  it("anchors a settled chain and refuses a cross-tenant read", () => {
    const keys = generateNotaryKeys();
    const notary = createNotary(keys);
    const ledger = createEvidenceLedger();
    const digest = digestExecution(createExecutionChain(chain()));
    const row = ledger.record(chain(), notary.include(digest), keys.publicPin);
    expect(row.anchored).toBe(true);
    expect(row.reconciliation.state).toBe("settled");

    const allowed = readEvidence({
      identity: { clientId: "client-a" },
      tenantGrants: TENANT_GRANTS,
      ledger,
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.records).toHaveLength(1);

    expect(readEvidence({
      identity: { clientId: "client-b" },
      tenantGrants: TENANT_GRANTS,
      tenant: "tenant-a",
      ledger,
    })).toEqual({ ok: false, reason: "not_entitled" });
  });

  it("binds control mappings to the live digest and evidence, never passed", () => {
    const keys = generateNotaryKeys();
    const notary = createNotary(keys);
    const ledger = createEvidenceLedger();
    const digest = digestExecution(createExecutionChain(chain()));
    ledger.record(chain(), notary.include(digest), keys.publicPin);

    const pack = exportAssessor({
      identity: { clientId: "client-a" },
      tenantGrants: TENANT_GRANTS,
      ledger,
      policyDigest: POLICY,
      attested: true,
    });
    expect(pack.ok).toBe(true);
    expect(pack.policyDigest).toBe(POLICY);
    expect(pack.attested).toBe(true);
    expect(isDataMinimized(pack)).toBe(true);
    expect(JSON.stringify(pack)).not.toMatch(/passed/i);
    expect(pack.executions[0]).toMatchObject({
      identityId: "id-a",
      decisionId: "dec-1",
      receiptId: "rcpt-1",
      localExecutionId: "req-1",
      targetRevision: "rev-1",
      anchored: true,
      reconcileState: "settled",
    });
    const byId = new Map(pack.controls.map((row) => [row.id, row]));
    expect(byId.get("P8.7")).toMatchObject({
      state: "evidenced",
      policyDigest: POLICY,
      evidence: {
        receiptId: "rcpt-1",
        digest,
      },
    });
    expect(byId.get("P8.7").evidence.anchorId).toBeTruthy();
    expect(byId.get("P5.3")).toMatchObject({
      state: "residual",
      policyDigest: POLICY,
      evidence: null,
      reason: "not_in_this_export",
    });
    expect(ASSESSOR_CONTROL_CATALOG.map((row) => row.id)).toEqual(
      pack.controls.map((row) => row.id),
    );
  });

  it("does not cite evidence when there is no live policy digest", () => {
    const keys = generateNotaryKeys();
    const notary = createNotary(keys);
    const ledger = createEvidenceLedger();
    const digest = digestExecution(createExecutionChain(chain()));
    ledger.record(chain(), notary.include(digest), keys.publicPin);
    const pack = exportAssessor({
      identity: { clientId: "client-a" },
      tenantGrants: TENANT_GRANTS,
      ledger,
    });
    expect(pack.ok).toBe(true);
    expect(pack.policyDigest).toBeNull();
    expect(pack.executions[0].anchored).toBe(true);
    expect(pack.controls.every((row) => row.state === "residual")).toBe(true);
    expect(pack.controls.every((row) => row.evidence === null)).toBe(true);
    expect(pack.controls.every((row) => row.reason === "no_live_policy_digest")).toBe(true);
    expect(JSON.stringify(pack)).not.toMatch(/passed/i);
  });

  it("leaves every control residual when nothing was independently anchored", () => {
    const ledger = createEvidenceLedger();
    ledger.record(chain(), null, null);
    const pack = exportAssessor({
      identity: { clientId: "client-a" },
      tenantGrants: TENANT_GRANTS,
      ledger,
      policyDigest: POLICY,
    });
    expect(pack.executions[0].anchored).toBe(false);
    expect(pack.controls.every((row) => row.state === "residual")).toBe(true);
    expect(pack.controls.every((row) => row.policyDigest === POLICY)).toBe(true);
    expect(pack.controls.every((row) => row.evidence === null)).toBe(true);
  });

  it("rejects an export that would carry a payload key", () => {
    expect(isDataMinimized({ receiptId: "r", prompt: "hello" })).toBe(false);
    expect(isDataMinimized({ receiptId: "r", nested: { email: "a@b.test" } })).toBe(false);
    expect(isDataMinimized({ receiptId: "r", digest: "ab" })).toBe(true);
  });
});
