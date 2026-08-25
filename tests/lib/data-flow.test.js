import { describe, expect, it, beforeEach } from "vitest";
import {
  HEADER_DECLARED_CEILING,
  HEADER_DECLARED_DESTINATION,
  REASON_BUDGET_CONTEXT_MISSING,
  REASON_CHAINED_ACTION,
  REASON_PAGE,
  REASON_READ,
  REASON_RESPONSE_SIZE,
  buildDataFlowContext,
  consumeBudget,
  getDataFlowContext,
  northboundHeaders,
  principalBudgetKey,
  resetDataFlowBudgets,
  runWithDataFlow,
} from "../../src/lib/data-flow.js";
import { SecurityError } from "../../src/lib/security.js";

const alice = { sub: "alice", clientId: "content-agent", scopes: ["mcp_read"] };
const bob = { sub: "bob", clientId: "content-agent", scopes: ["mcp_read"] };
const prod = { name: "production", baseUrl: "https://drupal.example.com", source: "grant" };
const staging = { name: "staging", baseUrl: "https://drupal-staging.example.com", source: "hint" };

const tight = {
  results: 5,
  bytes: 32,
  requests: 2,
  requestWindowSec: 60,
  pages: 2,
  pageWindowSec: 60,
  chainedActions: 2,
  chainedActionWindowSec: 60,
};

function ctx(over = {}) {
  return buildDataFlowContext({
    identity: alice,
    target: prod,
    limits: tight,
    now: () => 1_000,
    correlationId: "corr-test",
    ...over,
  });
}

beforeEach(() => {
  resetDataFlowBudgets();
});

describe("buildDataFlowContext", () => {
  it("binds the inbound principal and authoritative target, not a session", () => {
    const built = ctx();
    expect(built.principalKey).toBe(principalBudgetKey(alice));
    expect(built.targetName).toBe("production");
    expect(built.correlationId).toBe("corr-test");
    expect(built.principalKey).not.toMatch(/session/i);
  });

  it("uses a local-operator principal when inbound identity is absent", () => {
    const built = ctx({ identity: null });
    expect(built.principalKey).toBe("local-operator");
    expect(built.targetName).toBe("production");
  });

  it("refuses a governed context that names no target", () => {
    expect(() => ctx({ target: null })).toThrow(SecurityError);
    try {
      ctx({ target: { name: "", source: "hint" } });
    } catch (err) {
      expect(err.reason).toBe(REASON_BUDGET_CONTEXT_MISSING);
      expect(err.correlationId).toMatch(/^[0-9a-f-]{36}$|^corr-/);
      expect(err.message).not.toMatch(/article body|ssn|secret/i);
    }
  });
});

describe("northboundHeaders", () => {
  it("sends a sanitized destination and ceiling from the entitlement model", () => {
    const built = ctx({
      site: { security: { declaredCeiling: "internal" } },
    });
    const headers = runWithDataFlow(built, () => northboundHeaders());
    expect(headers[HEADER_DECLARED_CEILING]).toBe("internal");
    expect(headers[HEADER_DECLARED_DESTINATION]).toBe("content-agent:production");
    expect(headers[HEADER_DECLARED_DESTINATION]).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(headers[HEADER_DECLARED_DESTINATION].length).toBeLessThanOrEqual(128);
  });

  it("drops a malformed ceiling rather than inventing a wider one", () => {
    const built = ctx({
      site: { security: { declaredCeiling: "top secret!\n" } },
    });
    const headers = runWithDataFlow(built, () => northboundHeaders());
    expect(headers[HEADER_DECLARED_CEILING]).toBeUndefined();
    expect(headers[HEADER_DECLARED_DESTINATION]).toBe("content-agent:production");
  });

  it("sends nothing when there is no request-scoped context", () => {
    expect(northboundHeaders()).toEqual({});
  });
});

describe("consumeBudget", () => {
  it("keeps concurrent principals on independent request budgets", () => {
    const a = ctx({ identity: alice, correlationId: "corr-a" });
    const b = ctx({ identity: bob, correlationId: "corr-b" });
    runWithDataFlow(a, () => {
      consumeBudget("request");
      consumeBudget("request");
      expect(() => consumeBudget("request")).toThrow(SecurityError);
    });
    runWithDataFlow(b, () => {
      expect(() => consumeBudget("request")).not.toThrow();
    });
  });

  it("keeps multiple targets on independent page budgets", () => {
    const a = ctx({ target: prod, correlationId: "corr-prod" });
    const b = ctx({ target: staging, correlationId: "corr-stg" });
    runWithDataFlow(a, () => {
      consumeBudget("page");
      consumeBudget("page");
      expect(() => consumeBudget("page")).toThrow(SecurityError);
    });
    runWithDataFlow(b, () => {
      expect(() => consumeBudget("page")).not.toThrow();
    });
  });

  it("does not let pagination start a fresh page window", () => {
    const built = ctx();
    runWithDataFlow(built, () => {
      consumeBudget("page");
      consumeBudget("page");
      try {
        consumeBudget("page");
        throw new Error("expected page budget exhaustion");
      } catch (err) {
        expect(err.reason).toBe(REASON_PAGE);
        expect(err.correlationId).toBe("corr-test");
        expect(err.message).toContain(REASON_PAGE);
        expect(err.message).not.toContain("https://drupal.example.com");
      }
    });
  });

  it("does not let a retry reset the request budget", () => {
    const built = ctx();
    runWithDataFlow(built, () => {
      consumeBudget("request");
      consumeBudget("request", 1, { retry: true });
      consumeBudget("request");
      expect(() => consumeBudget("request")).toThrow(SecurityError);
      // A 401 replay of the request that already counted is the same slot.
      expect(() => consumeBudget("request", 1, { retry: true })).not.toThrow();
    });
    const unpaid = ctx({ correlationId: "corr-unpaid" });
    runWithDataFlow(unpaid, () => {
      expect(() => consumeBudget("request", 1, { retry: true })).toThrow(SecurityError);
    });
  });

  it("does not let batching or a new chain id reset chained-action exhaustion", () => {
    const first = ctx({ correlationId: "chain-1" });
    runWithDataFlow(first, () => {
      consumeBudget("chained_action");
      consumeBudget("chained_action");
    });
    const replay = ctx({ correlationId: "chain-2" });
    runWithDataFlow(replay, () => {
      try {
        consumeBudget("chained_action");
        throw new Error("expected chained-action exhaustion");
      } catch (err) {
        expect(err.reason).toBe(REASON_CHAINED_ACTION);
        expect(err.correlationId).toBe("chain-2");
      }
    });
  });

  it("caps rows and bytes on the current request without leaking the body", () => {
    const built = ctx();
    runWithDataFlow(built, () => {
      consumeBudget("request");
      consumeBudget("rows", 5);
      try {
        consumeBudget("rows", 1);
        throw new Error("expected row budget exhaustion");
      } catch (err) {
        expect(err.reason).toBe(REASON_READ);
        expect(JSON.stringify(err)).not.toContain("restricted-body");
      }
      try {
        consumeBudget("bytes", 33);
        throw new Error("expected byte budget exhaustion");
      } catch (err) {
        expect(err.reason).toBe(REASON_RESPONSE_SIZE);
      }
    });
  });

  it("fails closed when budget is consumed without request-scoped context", () => {
    try {
      consumeBudget("request");
      throw new Error("expected missing-context denial");
    } catch (err) {
      expect(err).toBeInstanceOf(SecurityError);
      expect(err.reason).toBe(REASON_BUDGET_CONTEXT_MISSING);
      expect(err.correlationId).toBeTruthy();
    }
  });

  it("does not use AsyncLocalStorage identity as a substitute for a bound target", () => {
    const incomplete = {
      principalKey: principalBudgetKey(alice),
      targetName: "",
      correlationId: "corr-incomplete",
      limits: tight,
      now: () => 1_000,
    };
    runWithDataFlow(incomplete, () => {
      expect(() => consumeBudget("request")).toThrow(SecurityError);
    });
    expect(getDataFlowContext()).toBeNull();
  });
});
