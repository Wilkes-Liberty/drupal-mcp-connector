import { describe, expect, it } from "vitest";
import {
  REASON,
  createDrupalAdapter,
  createEvaluator,
  createMemoryBackend,
  createMemoryEvidenceSink,
} from "../../src/lib/contracts/index.js";
import {
  caseAllowedAction,
  caseDeniedAction,
  caseEvidenceWriteFailure,
  caseHostileModality,
  caseHostileVendorField,
  casePostconditionDiscrepancy,
  caseReplay,
  caseTenantEscape,
  runEvaluate,
} from "./kit.js";

const production = {
  _name: "production",
  baseUrl: "https://drupal.example.com",
  security: { preset: "content-editor" },
};

const staging = {
  _name: "staging",
  baseUrl: "https://drupal-staging.example.com",
  security: { preset: "content-editor" },
};

const openDev = {
  _name: "development",
  baseUrl: "https://drupal.example.test",
  security: { preset: "development" },
};

const grants = { "content-agent": ["production"] };

function identity(over = {}) {
  return {
    sub: "agent-1",
    clientId: "content-agent",
    scopes: ["mcp_read", "mcp_write", "mcp_config"],
    ...over,
  };
}

function adapter(over = {}) {
  const site = over.site ?? production;
  const sites = over.sites ?? [production, staging, openDev];
  return createDrupalAdapter({
    site,
    sites,
    identity: over.identity ?? identity(),
    grants: over.grants ?? grants,
    backend: over.backend,
    evidence: over.evidence,
    approval: over.approval,
    upstreamEvaluator: over.upstreamEvaluator,
    assuranceClass: over.assuranceClass,
  });
}

describe("Drupal conformance kit — allowed and denied", () => {
  it("allows a bounded node read", () => {
    const { decision } = caseAllowedAction(adapter(), {
      operation: "read",
      entityType: "node",
      bundle: "article",
      id: "n1",
      hints: { site: "production" },
    });
    expect(decision.result).toBe("allow");
    expect(decision.policyDigest).toBe("content-editor:connector-local");
    expect(decision.evaluatorVersion).toBe("1.0");
  });

  it("allows a draft create as a reversible write", async () => {
    const harness = adapter({ backend: createMemoryBackend() });
    const { manifest, decision } = caseAllowedAction(harness, {
      operation: "create",
      entityType: "node",
      bundle: "article",
      attributes: { title: "Draft", status: false },
      expectedEffects: { status: false },
      hints: { site: "production" },
    });
    expect(decision.result).toBe("allow");
    const receipt = await harness.execute(manifest, decision);
    expect(receipt.outcome).toBe("ok");
    expect(receipt.decisionId).toBe(decision.decisionId);
  });

  it("denies delete and publish on content-editor", () => {
    caseDeniedAction(adapter(), {
      operation: "delete",
      entityType: "node",
      bundle: "article",
      id: "n1",
      hints: { site: "production" },
    }, REASON.TARGET_DENIED);

    caseDeniedAction(adapter(), {
      operation: "update",
      entityType: "node",
      bundle: "article",
      id: "n1",
      attributes: { status: true },
      hints: { site: "production" },
    }, REASON.TARGET_DENIED);
  });

  it("denies control-plane config writes", () => {
    caseDeniedAction(adapter(), {
      operation: "config_set",
      entityType: "node_type",
      hints: { site: "production" },
    }, REASON.TARGET_DENIED);
  });

  it("imposes a read-budget obligation on list/export", () => {
    const { decision } = caseAllowedAction(adapter(), {
      operation: "list",
      entityType: "node",
      bundle: "article",
      hints: { site: "production" },
    });
    expect(decision.result).toBe("allow_with_obligations");
    expect(decision.obligations).toEqual([
      expect.objectContaining({ type: "read_budget" }),
    ]);
  });
});

describe("Drupal conformance kit — hostile input modalities", () => {
  it("rejects model and agent vendor fields at propose", () => {
    caseHostileVendorField(adapter(), {
      operation: "read",
      entityType: "node",
      model: "gpt",
    });
    caseHostileVendorField(adapter(), {
      operation: "read",
      entityType: "node",
      agentVendor: "acme",
    });
    caseHostileVendorField(adapter(), {
      operation: "read",
      entityType: "node",
      hints: { model: "gpt" },
    });
  });

  it("denies script HTML and path-escape uploads", () => {
    caseHostileModality(adapter(), {
      operation: "update",
      entityType: "node",
      bundle: "article",
      id: "n1",
      attributes: { body: { value: "<script>alert(1)</script>" } },
      hints: { site: "production" },
    });
    caseHostileModality(adapter(), {
      operation: "create",
      entityType: "file",
      filePath: "/etc/passwd",
      hints: { site: "production" },
    });
    caseHostileModality(adapter(), {
      operation: "create",
      entityType: "file",
      filePath: "../../.ssh/id_rsa",
      hints: { site: "production" },
    });
  });
});

describe("Drupal conformance kit — tenant escape", () => {
  it("denies a hint for a site the principal is not granted", () => {
    caseTenantEscape(adapter(), {
      operation: "read",
      entityType: "node",
      bundle: "article",
      hints: { site: "staging" },
    });
  });
});

describe("Drupal conformance kit — evidence, replay, post-condition", () => {
  it("fails closed when required evidence cannot be written", async () => {
    await caseEvidenceWriteFailure(adapter({
      site: openDev,
      grants: { "content-agent": ["development"] },
      evidence: createMemoryEvidenceSink({ failRequired: true }),
      backend: createMemoryBackend(),
    }), {
      operation: "delete",
      entityType: "node",
      bundle: "article",
      id: "n-del",
      hints: { site: "development" },
    });
  });

  it("rejects replay of a consumed approval", async () => {
    const harness = adapter({
      site: openDev,
      grants: { "content-agent": ["development"] },
      backend: createMemoryBackend(),
    });
    const { first } = await caseReplay(harness, {
      operation: "delete",
      entityType: "node",
      bundle: "article",
      id: "n-replay",
      hints: { site: "development" },
    });
    expect(first.outcome).toBe("ok");
  });

  it("surfaces a post-condition discrepancy as unknown, never green", async () => {
    await casePostconditionDiscrepancy(adapter({
      backend: createMemoryBackend({ mismatch: { status: true } }),
    }), {
      operation: "create",
      entityType: "node",
      bundle: "article",
      attributes: { title: "Draft", status: false },
      expectedEffects: { status: false },
      hints: { site: "production" },
    });
  });
});

describe("Drupal conformance kit — narrowing and version", () => {
  it("does not let an upstream allow widen a local deny", () => {
    const harness = adapter({
      upstreamEvaluator: createEvaluator(() => ({
        decisionId: "up-1",
        result: "allow",
        reason: "allow",
        reasons: ["allow"],
        obligations: [],
        evaluatorVersion: "1.0",
      })),
    });
    const { decision } = caseDeniedAction(harness, {
      operation: "delete",
      entityType: "node",
      bundle: "article",
      id: "n1",
      hints: { site: "production" },
    }, REASON.TARGET_DENIED);
    expect(decision.result).toBe("deny");
  });

  it("negotiates the 1.x contract and refuses a foreign major", () => {
    const harness = adapter();
    const { manifest } = runEvaluate(harness, {
      operation: "read",
      entityType: "node",
      contractVersion: "1.2",
      hints: { site: "production" },
    });
    expect(manifest.contractVersion).toBe("1.0");
    expect(() => harness.propose({
      operation: "read",
      entityType: "node",
      contractVersion: "2.0",
    })).toThrow();
  });
});
