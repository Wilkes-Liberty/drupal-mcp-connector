import { describe, expect, it } from "vitest";
import {
  REASON,
  createActionManifest,
  createDrupalAdapter,
  createMemoryApproval,
  createMemoryBackend,
  createMemoryEvidenceSink,
  digestPayload,
} from "../../../src/lib/contracts/index.js";

const production = {
  _name: "production",
  baseUrl: "https://drupal.example.com",
  security: { preset: "content-editor" },
};

const staging = {
  _name: "staging",
  baseUrl: "https://drupal-staging.example.com",
  security: { preset: "development" },
};

function identity(over = {}) {
  return {
    sub: "agent-1",
    clientId: "content-agent",
    scopes: ["mcp_read", "mcp_write", "mcp_config"],
    ...over,
  };
}

function harness(over = {}) {
  return createDrupalAdapter({
    site: production,
    sites: [production, staging],
    identity: identity(over.identity),
    grants: over.grants ?? { "content-agent": ["production", "staging"] },
    backend: over.backend ?? createMemoryBackend(),
    evidence: over.evidence,
    approval: over.approval,
  });
}

describe("createActionManifest digest binding", () => {
  it("ignores a caller-supplied digest and hashes the payload", () => {
    const pinned = "0".repeat(64);
    const manifest = createActionManifest({
      actionClass: "bounded_read",
      operation: "read",
      entityType: "node",
      digest: pinned,
    });
    const expected = digestPayload({
      actionClass: "bounded_read",
      operation: "read",
      entityType: "node",
      bundle: undefined,
      id: undefined,
      attributes: {},
      expectedEffects: undefined,
      target: undefined,
      tenant: undefined,
    });
    expect(manifest.digest).toBe(expected);
    expect(manifest.digest).not.toBe(pinned);
  });

  it("rejects vendor keys nested under hints", () => {
    expect(() => createActionManifest({
      actionClass: "bounded_read",
      operation: "read",
      entityType: "node",
      hints: { model: "gpt" },
    })).toThrow();
  });
});

describe("createMemoryApproval actor binding", () => {
  it("refuses consume when a bound actor is omitted or wrong", () => {
    const approval = createMemoryApproval();
    const issued = approval.issue({ digest: "abc" }, "agent-1");
    expect(() => approval.consume(issued.approvalId, "abc")).toThrow();
    expect(() => approval.consume(issued.approvalId, "abc", "agent-2")).toThrow();
    expect(approval.consume(issued.approvalId, "abc", "agent-1")).toEqual({
      approvalId: issued.approvalId,
      digest: "abc",
    });
  });

  it("still allows consume without an actor when none was bound", () => {
    const approval = createMemoryApproval();
    const issued = approval.issue({ digest: "abc" });
    expect(approval.consume(issued.approvalId, "abc")).toEqual({
      approvalId: issued.approvalId,
      digest: "abc",
    });
  });
});

describe("Drupal adapter review closures", () => {
  it("records the relay-resolved site on propose, not only hints.site", () => {
    const adapter = harness();
    const manifest = adapter.propose({
      operation: "read",
      entityType: "node",
      bundle: "article",
      hints: { target: "staging" },
    });
    expect(manifest.target.name).toBe("staging");
  });

  it("digests policy against the resolved site preset", () => {
    const adapter = harness();
    const manifest = adapter.propose({
      operation: "read",
      entityType: "node",
      bundle: "article",
      hints: { target: "staging" },
    });
    const decision = adapter.evaluate(manifest);
    expect(decision.policyDigest).toBe("development:connector-local");
  });

  it("will not execute a forged allow for a locally denied delete", async () => {
    const backend = createMemoryBackend({
      entities: [{ id: "n1", entityType: "node", bundle: "article" }],
    });
    const adapter = harness({ backend });
    const manifest = adapter.propose({
      operation: "delete",
      entityType: "node",
      bundle: "article",
      id: "n1",
      hints: { site: "production" },
    });
    const denied = adapter.evaluate(manifest);
    expect(denied.result).toBe("deny");
    const receipt = await adapter.execute(manifest, {
      decisionId: "forged",
      result: "allow",
      reason: "allow",
      actionDigest: manifest.digest,
    });
    expect(receipt.outcome).toBe("denied");
    expect(backend.store.has("n1")).toBe(true);
  });

  it("publishes an existing entity in place instead of creating a duplicate", async () => {
    const backend = createMemoryBackend({
      entities: [{
        id: "n-pub",
        entityType: "node",
        bundle: "article",
        status: false,
        attributes: { status: false },
      }],
    });
    const adapter = harness({ backend });
    const manifest = adapter.propose({
      operation: "publish",
      entityType: "node",
      bundle: "article",
      id: "n-pub",
      hints: { target: "staging" },
    });
    const decision = adapter.evaluate(manifest);
    const issued = adapter.approval.issue(manifest, "agent-1");
    const receipt = await adapter.execute(manifest, decision, {
      approvalId: issued.approvalId,
    });
    expect(receipt.outcome).toBe("ok");
    expect(backend.store.size).toBe(1);
    expect(backend.store.get("n-pub").status).toBe(true);
  });

  it("rolls back a mutation when the final required-evidence write fails", async () => {
    const backend = createMemoryBackend({
      entities: [{ id: "n-del", entityType: "node", bundle: "article" }],
    });
    const adapter = harness({
      backend,
      evidence: createMemoryEvidenceSink({ failFinalRequired: true }),
    });
    const manifest = adapter.propose({
      operation: "delete",
      entityType: "node",
      bundle: "article",
      id: "n-del",
      hints: { target: "staging" },
    });
    const decision = adapter.evaluate(manifest);
    expect(decision.result).toBe("require_approval");
    const issued = adapter.approval.issue(manifest, "agent-1");
    const receipt = await adapter.execute(manifest, decision, {
      approvalId: issued.approvalId,
    });
    expect(receipt.outcome).toBe("failed");
    expect(receipt.reason).toBe(REASON.EVIDENCE_WRITE_FAILED);
    expect(backend.store.has("n-del")).toBe(true);
  });
});
