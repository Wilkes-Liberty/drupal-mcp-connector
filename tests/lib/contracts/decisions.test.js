import { describe, expect, it } from "vitest";
import {
  ContractError,
  REASON,
  assertNoVendorFields,
  composeDecisions,
  createDecisionRecord,
  unionObligations,
} from "../../../src/lib/contracts/index.js";

function decision(result, over = {}) {
  return createDecisionRecord({
    result,
    reason: over.reason ?? result,
    obligations: over.obligations ?? [],
    actionDigest: "digest",
    policyDigest: "content-editor:connector-local",
    target: { name: "production" },
    actionClass: "bounded_read",
    ...over,
  });
}

describe("composeDecisions", () => {
  it("keeps a local deny when upstream allowed", () => {
    const local = decision("deny", { reason: REASON.TARGET_DENIED });
    const upstream = decision("allow", { reason: "allow" });
    const composed = composeDecisions(upstream, local);
    expect(composed.result).toBe("deny");
    expect(composed.reason).toBe(REASON.TARGET_DENIED);
  });

  it("keeps an upstream deny when local allowed", () => {
    const composed = composeDecisions(
      decision("deny", { reason: REASON.POLICY_DENIED }),
      decision("allow"),
    );
    expect(composed.result).toBe("deny");
    expect(composed.reason).toBe(REASON.POLICY_DENIED);
  });

  it("narrows allow to require_approval", () => {
    const composed = composeDecisions(
      decision("allow"),
      decision("require_approval", { reason: REASON.APPROVAL_REQUIRED }),
    );
    expect(composed.result).toBe("require_approval");
  });

  it("unions obligations only when both sides allow", () => {
    const composed = composeDecisions(
      decision("allow_with_obligations", { obligations: [{ type: "read_budget" }] }),
      decision("allow", { obligations: [{ type: "redact", value: "mail" }] }),
    );
    expect(composed.result).toBe("allow_with_obligations");
    expect(composed.obligations).toEqual([
      { type: "read_budget", value: undefined },
      { type: "redact", value: "mail" },
    ]);
  });

  it("returns local when upstream is absent", () => {
    const local = decision("allow");
    expect(composeDecisions(null, local)).toBe(local);
  });
});

describe("assertNoVendorFields", () => {
  it("rejects model and agent vendor keys", () => {
    expect(() => assertNoVendorFields({ model: "gpt" })).toThrow(ContractError);
    expect(() => assertNoVendorFields({ agentVendor: "acme" })).toThrow(ContractError);
    try {
      assertNoVendorFields({ llmProvider: "vendor" });
    } catch (err) {
      expect(err.reason).toBe(REASON.VENDOR_FIELD);
    }
  });

  it("accepts a vendor-free identity", () => {
    expect(() => assertNoVendorFields({ subject: "agent-1", scopes: ["mcp_read"] })).not.toThrow();
  });
});

describe("unionObligations", () => {
  it("dedupes by type and value", () => {
    expect(unionObligations(
      [{ type: "read_budget" }, { type: "read_budget" }],
      [{ type: "read_budget" }],
    )).toEqual([{ type: "read_budget", value: undefined }]);
  });
});
