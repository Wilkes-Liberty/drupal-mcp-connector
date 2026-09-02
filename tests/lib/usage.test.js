/**
 * Attributable usage, quotas, and abuse signals (#256 / DEV-126) — pure rules.
 *
 * No sockets. The ledger partitions by tenant and principal, the quota gate
 * fails closed at its declared boundary, cross-tenant reads are denied before
 * a record is looked at, and reconciliation names missing, duplicate, and
 * uncertain chains. Every deny here was watched failing before usage.js
 * existed.
 */

import { describe, expect, it } from "vitest";
import {
  attributedTenant,
  createQuotaGate,
  createUsageLedger,
  normalizeQuotas,
  quotasRequired,
  readUsage,
  reconcileUsage,
  usagePrincipalKey,
} from "../../src/lib/usage.js";

const TENANT_GRANTS = { "client-a": ["tenant-a"], "client-b": ["tenant-b"] };

function decision(overrides = {}) {
  return {
    phase: "decision",
    decision: "allow",
    reason: null,
    requestId: "req-1",
    tenant: "tenant-a",
    principal: { clientId: "client-a", sub: "sub-a" },
    principalKey: "sub-a",
    method: "tools/call",
    tool: "drupal_list_nodes",
    policyDigest: "ab".repeat(32),
    units: 1,
    bytesIn: 10,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    phase: "receipt",
    requestId: "req-1",
    tenant: "tenant-a",
    principalKey: "sub-a",
    outcome: "ok",
    status: 200,
    bytesOut: 20,
    durationMs: 5,
    ...overrides,
  };
}

describe("usagePrincipalKey / attributedTenant", () => {
  it("keys the principal by sub, then azp, raw as issued, and never by a caller field", () => {
    expect(usagePrincipalKey({ sub: "sub-a", clientId: "client-a" })).toBe("sub-a");
    expect(usagePrincipalKey({ sub: null, clientId: "client-a" })).toBe("client-a");
    expect(usagePrincipalKey({ sub: "", clientId: "client-a" })).toBe("client-a");
    // Identity values are used exactly as the issuer minted them, like
    // resolveTenantRoute / resolveActor; only config keys are trimmed.
    expect(usagePrincipalKey({ sub: " sub-a ", clientId: "client-a" })).toBe(" sub-a ");
    expect(usagePrincipalKey({ sub: null, clientId: " client-a " })).toBe(" client-a ");
    expect(usagePrincipalKey({ actor: "spoof" })).toBeNull();
    expect(usagePrincipalKey(null)).toBeNull();
  });

  it("attributes the unique granted tenant and nothing else", () => {
    expect(attributedTenant({ clientId: "client-a" }, TENANT_GRANTS)).toBe("tenant-a");
    expect(attributedTenant({ clientId: "client-x" }, TENANT_GRANTS)).toBeNull();
    expect(attributedTenant({ clientId: "client-a" }, null)).toBeNull();
    expect(attributedTenant(
      { clientId: "client-a" },
      { "client-a": ["tenant-a", "tenant-b"] },
    )).toBeNull();
    expect(attributedTenant({ clientId: "client-a", tenant: "tenant-b" }, TENANT_GRANTS))
      .toBe("tenant-a");
  });
});

describe("normalizeQuotas / quotasRequired", () => {
  it("treats a missing or comment-only table as omitted", () => {
    expect(normalizeQuotas(null)).toBeNull();
    expect(normalizeQuotas(undefined)).toBeNull();
    expect(normalizeQuotas({ _comment: "x" })).toBeNull();
    expect(normalizeQuotas({ tenants: { _comment: "x" } })).toBeNull();
    expect(quotasRequired(null)).toBe(false);
    expect(quotasRequired({ _comment: "x" })).toBe(false);
    expect(quotasRequired({ tenants: { _comment: "x" } })).toBe(false);
  });

  it("keeps well-formed rows and defaults the window", () => {
    const table = normalizeQuotas({
      tenants: {
        "tenant-a": { requests: 5 },
        " tenant-b ": { requests: 2, windowSec: 30 },
        _comment: "ignored",
      },
      principals: { "sub-a": { requests: 1, windowSec: 10 } },
      abuse: { denials: 3 },
    });
    expect(table.invalid).toBeUndefined();
    expect(table.tenants).toEqual({
      "tenant-a": { requests: 5, windowSec: 60 },
      "tenant-b": { requests: 2, windowSec: 30 },
    });
    expect(table.tenantsRequired).toBe(true);
    expect(table.principals).toEqual({ "sub-a": { requests: 1, windowSec: 10 } });
    expect(table.principalsRequired).toBe(true);
    expect(table.abuse).toEqual({ denials: 3, windowSec: 60, lockSec: 300 });
  });

  it("flags a malformed row as invalid and names it, instead of dropping it", () => {
    expect(normalizeQuotas({ tenants: { "tenant-bad": { requests: 0 } } }))
      .toEqual({ invalid: true, reason: "tenants.tenant-bad.requests" });
    expect(normalizeQuotas({ tenants: { "tenant-neg": { requests: -1, windowSec: 60 } } }))
      .toEqual({ invalid: true, reason: "tenants.tenant-neg.requests" });
    expect(normalizeQuotas({ tenants: { "tenant-str": { requests: "5" } } }))
      .toEqual({ invalid: true, reason: "tenants.tenant-str.requests" });
    expect(normalizeQuotas({ tenants: { "tenant-obj": "5" } }))
      .toEqual({ invalid: true, reason: "tenants.tenant-obj" });
    expect(normalizeQuotas({ principals: { "sub-a": { requests: 1, windowSec: 0 } } }))
      .toEqual({ invalid: true, reason: "principals.sub-a.windowSec" });
    expect(quotasRequired({ tenants: { "tenant-bad": { requests: 0 } } })).toBe(true);
  });

  it("flags a present table that is not an object as invalid, never as omitted", () => {
    for (const raw of ["oops", [], [{ tenants: {} }], 5, true, false]) {
      expect(normalizeQuotas(raw)).toEqual({ invalid: true, reason: "quotas" });
      expect(quotasRequired(raw)).toBe(true);
    }
  });

  it("flags an unknown key or a non-object sub-table as invalid, never as omitted", () => {
    expect(normalizeQuotas({ tenants: "oops" })).toEqual({ invalid: true, reason: "tenants" });
    expect(normalizeQuotas({ tenants: [{ id: "tenant-a", requests: 5 }] }))
      .toEqual({ invalid: true, reason: "tenants" });
    expect(normalizeQuotas({ tenant: { "tenant-a": { requests: 10 } } }))
      .toEqual({ invalid: true, reason: "tenant" });
    expect(normalizeQuotas({ principal: { "sub-a": { requests: 10 } } }))
      .toEqual({ invalid: true, reason: "principal" });
    expect(normalizeQuotas({ abuseLock: { denials: 3 } }))
      .toEqual({ invalid: true, reason: "abuseLock" });
    expect(quotasRequired({ tenants: "oops" })).toBe(true);
  });

  it("flags a malformed abuse block instead of inventing defaults", () => {
    expect(normalizeQuotas({ abuse: { denials: 0 } })).toEqual({ invalid: true, reason: "abuse.denials" });
    expect(normalizeQuotas({ abuse: "3" })).toEqual({ invalid: true, reason: "abuse" });
    expect(normalizeQuotas({ abuse: { denials: 2, lockSec: -1 } }))
      .toEqual({ invalid: true, reason: "abuse.lockSec" });
    expect(normalizeQuotas({ abuse: {} })).toEqual({ invalid: true, reason: "abuse.denials" });
  });
});

describe("createQuotaGate", () => {
  const principal = { tenant: "tenant-a", principalKey: "sub-a" };

  it("is a no-op when the table is omitted", () => {
    const gate = createQuotaGate({ quotas: null });
    expect(gate.enabled).toBe(false);
    expect(gate.check(principal)).toEqual({ allowed: true });
    expect(gate.noteDenial("sub-a")).toEqual({ locked: false });
    expect(gate.check(principal)).toEqual({ allowed: true });
  });

  it("denies a tenant without a row when the tenants table is present", () => {
    const gate = createQuotaGate({ quotas: { tenants: { "tenant-b": { requests: 5 } } } });
    expect(gate.enabled).toBe(true);
    expect(gate.check(principal)).toEqual({
      allowed: false, reason: "not_entitled", scope: "tenant", retryAfterSec: 0,
    });
    expect(gate.check({ tenant: null, principalKey: "sub-a" })).toEqual({
      allowed: false, reason: "not_entitled", scope: "tenant", retryAfterSec: 0,
    });
    expect(gate.check({ tenant: "tenant-b", principalKey: "sub-a" })).toEqual({ allowed: true });
  });

  it("looks principals up raw, so a padded identity never matches a trimmed row", () => {
    const gate = createQuotaGate({
      quotas: { principals: { " sub-a ": { requests: 5 } }, abuse: { denials: 5 } },
    });
    expect(gate.check({ tenant: "tenant-a", principalKey: "sub-a" })).toEqual({ allowed: true });
    expect(gate.check({ tenant: "tenant-a", principalKey: " sub-a " })).toEqual({
      allowed: false, reason: "not_entitled", scope: "principal", retryAfterSec: 0,
    });
    gate.noteDenial(" sub-a ");
    expect(gate.state(" sub-a ").denials).toBe(1);
    expect(gate.state("sub-a").denials).toBe(0);
  });

  it("denies a principal without a row when the principals table is present", () => {
    const gate = createQuotaGate({ quotas: { principals: { "sub-b": { requests: 5 } } } });
    expect(gate.check(principal)).toEqual({
      allowed: false, reason: "not_entitled", scope: "principal", retryAfterSec: 0,
    });
    expect(gate.check({ tenant: "tenant-a", principalKey: null })).toEqual({
      allowed: false, reason: "not_entitled", scope: "principal", retryAfterSec: 0,
    });
    expect(gate.check({ tenant: "tenant-a", principalKey: "sub-b" })).toEqual({ allowed: true });
  });

  it("exhausts a tenant window, names retry-after, and resets when the window rolls", () => {
    let t = 1_000;
    const gate = createQuotaGate({
      quotas: { tenants: { "tenant-a": { requests: 2, windowSec: 10 } } },
      now: () => t,
    });
    expect(gate.check(principal)).toEqual({ allowed: true });
    expect(gate.check(principal)).toEqual({ allowed: true });
    expect(gate.check(principal)).toEqual({
      allowed: false, reason: "quota_exceeded", scope: "tenant", retryAfterSec: 10,
    });
    t += 10_000;
    expect(gate.check(principal)).toEqual({ allowed: true });
  });

  it("keeps tenant and principal windows separate", () => {
    const gate = createQuotaGate({
      quotas: {
        tenants: { "tenant-a": { requests: 10 } },
        principals: { "sub-a": { requests: 1 }, "sub-b": { requests: 1 } },
      },
    });
    expect(gate.check(principal)).toEqual({ allowed: true });
    expect(gate.check(principal)).toMatchObject({
      allowed: false, reason: "quota_exceeded", scope: "principal",
    });
    expect(gate.check({ tenant: "tenant-a", principalKey: "sub-b" })).toEqual({ allowed: true });
  });

  it("locks a principal after the declared denial count and releases after lockSec", () => {
    let t = 0;
    const gate = createQuotaGate({
      quotas: { abuse: { denials: 2, windowSec: 60, lockSec: 30 } },
      now: () => t,
    });
    expect(gate.noteDenial("sub-a")).toEqual({ locked: false });
    expect(gate.check(principal)).toEqual({ allowed: true });
    expect(gate.noteDenial("sub-a")).toEqual({ locked: true, retryAfterSec: 30 });
    expect(gate.check(principal)).toEqual({
      allowed: false, reason: "abuse_locked", scope: "abuse", retryAfterSec: 30,
    });
    expect(gate.check({ tenant: "tenant-a", principalKey: "sub-b" })).toEqual({ allowed: true });
    expect(gate.state("sub-a")).toEqual({ locked: true, retryAfterSec: 30, denials: 2 });
    t = 30_000;
    expect(gate.check(principal)).toEqual({ allowed: true });
    expect(gate.state("sub-a")).toEqual({ locked: false, retryAfterSec: 0, denials: 0 });
  });

  it("forgets denials that fall outside the abuse window", () => {
    let t = 0;
    const gate = createQuotaGate({
      quotas: { abuse: { denials: 2, windowSec: 10, lockSec: 30 } },
      now: () => t,
    });
    gate.noteDenial("sub-a");
    t = 11_000;
    expect(gate.noteDenial("sub-a")).toEqual({ locked: false });
    expect(gate.check(principal)).toEqual({ allowed: true });
  });

  it("refuses every request when the table is invalid, whatever the defect", () => {
    for (const quotas of [
      { abuse: { denials: 0 } },
      { tenants: "oops" },
      { tenant: { "tenant-a": { requests: 10 } } },
      { tenants: { "tenant-a": { requests: "10" } } },
    ]) {
      const gate = createQuotaGate({ quotas });
      expect(gate.enabled).toBe(true);
      expect(gate.invalid).toBe(true);
      expect(gate.check(principal)).toEqual({
        allowed: false, reason: "not_entitled", scope: "config", retryAfterSec: 0,
      });
    }
  });

  it("bounds the denial table and prunes principals whose denials expired", () => {
    let t = 0;
    const gate = createQuotaGate({
      quotas: { abuse: { denials: 5, windowSec: 10, lockSec: 30 } },
      now: () => t,
      maxKeys: 2,
    });
    gate.noteDenial("sub-a");
    gate.noteDenial("sub-b");
    expect(gate.stats()).toEqual({ trackedPrincipals: 2, maxKeys: 2 });
    t = 11_000;
    gate.noteDenial("sub-c");
    expect(gate.stats().trackedPrincipals).toBe(1);
    gate.noteDenial("sub-d");
    gate.noteDenial("sub-e");
    expect(gate.stats().trackedPrincipals).toBeLessThanOrEqual(2);
    expect(gate.state("sub-c").denials).toBe(0);
  });

  it("ignores a denial note for an unkeyed principal", () => {
    const gate = createQuotaGate({ quotas: { abuse: { denials: 1 } } });
    expect(gate.noteDenial(null)).toEqual({ locked: false });
    expect(gate.noteDenial("")).toEqual({ locked: false });
    expect(gate.check(principal)).toEqual({ allowed: true });
  });
});

describe("createUsageLedger", () => {
  it("stamps seq, time, and a decisionId, and freezes the record", () => {
    const ledger = createUsageLedger({ now: () => 1_700_000_000_000 });
    const first = ledger.record(decision());
    expect(first.seq).toBe(1);
    expect(first.at).toBe("2023-11-14T22:13:20.000Z");
    expect(first.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(first)).toBe(true);
    const second = ledger.record(receipt({ decisionId: first.decisionId }));
    expect(second.seq).toBe(2);
    expect(second.receiptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.decisionId).toBe(first.decisionId);
    expect(ledger.size).toBe(2);
  });

  it("refuses records outside the phase / decision vocabulary", () => {
    const ledger = createUsageLedger();
    expect(() => ledger.record({ phase: "billing" })).toThrow(TypeError);
    expect(() => ledger.record(decision({ decision: "maybe" }))).toThrow(TypeError);
    expect(() => ledger.record(receipt({ outcome: "priced" }))).toThrow(TypeError);
    expect(ledger.size).toBe(0);
  });

  it("partitions by tenant and by principal", () => {
    const ledger = createUsageLedger();
    ledger.record(decision({ requestId: "a1" }));
    ledger.record(decision({ requestId: "a2", principalKey: "sub-a2", principal: { clientId: "client-a", sub: "sub-a2" } }));
    ledger.record(decision({ requestId: "b1", tenant: "tenant-b", principalKey: "sub-b", principal: { clientId: "client-b", sub: "sub-b" } }));
    ledger.record(decision({ requestId: null, tenant: null, decision: "deny", reason: "not_entitled", principalKey: "sub-x" }));
    expect(ledger.query({ tenant: "tenant-a" }).map((row) => row.requestId)).toEqual(["a1", "a2"]);
    expect(ledger.query({ tenant: "tenant-b" }).map((row) => row.requestId)).toEqual(["b1"]);
    expect(ledger.query({ tenant: "tenant-a", principalKey: "sub-a2" }).map((row) => row.requestId))
      .toEqual(["a2"]);
    expect(ledger.query({ tenant: "tenant-c" })).toEqual([]);
    expect(ledger.query({ tenant: null })).toEqual([]);
    expect(ledger.query({})).toEqual([]);
    expect(ledger.records()).toHaveLength(4);
  });

  it("refuses a bound that is not a positive integer instead of substituting a default", () => {
    for (const maxRecords of [0, -1, 1.5, "100", Number.NaN]) {
      expect(() => createUsageLedger({ maxRecords })).toThrow(TypeError);
    }
    expect(createUsageLedger().stats().maxRecords).toBe(10_000);
  });

  it("bounds the ledger and counts what it dropped", () => {
    const ledger = createUsageLedger({ maxRecords: 2 });
    ledger.record(decision({ requestId: "r1" }));
    ledger.record(decision({ requestId: "r2" }));
    ledger.record(decision({ requestId: "r3" }));
    expect(ledger.records().map((row) => row.requestId)).toEqual(["r2", "r3"]);
    expect(ledger.stats()).toEqual({ size: 2, dropped: 1, maxRecords: 2 });
  });
});

describe("readUsage (cross-tenant visibility)", () => {
  function seeded() {
    const ledger = createUsageLedger();
    ledger.record(decision({ requestId: "a1" }));
    ledger.record(receipt({ requestId: "a1" }));
    ledger.record(decision({
      requestId: "b1", tenant: "tenant-b", principalKey: "sub-b",
      principal: { clientId: "client-b", sub: "sub-b" },
    }));
    return ledger;
  }

  it("denies another tenant's partition with zero records, hint or not", () => {
    const ledger = seeded();
    expect(readUsage({
      identity: { clientId: "client-b", sub: "sub-b" },
      tenantGrants: TENANT_GRANTS,
      tenant: "tenant-a",
      ledger,
    })).toEqual({ ok: false, reason: "not_entitled" });
    expect(readUsage({
      identity: { clientId: "client-x", sub: "sub-x" },
      tenantGrants: TENANT_GRANTS,
      ledger,
    })).toEqual({ ok: false, reason: "not_entitled" });
  });

  it("denies without a tenant grant table, a ledger, or a unique tenant", () => {
    const ledger = seeded();
    const identity = { clientId: "client-a", sub: "sub-a" };
    expect(readUsage({ identity, tenantGrants: null, ledger }))
      .toEqual({ ok: false, reason: "not_entitled" });
    expect(readUsage({ identity, tenantGrants: TENANT_GRANTS, ledger: null }))
      .toEqual({ ok: false, reason: "not_entitled" });
    expect(readUsage({
      identity,
      tenantGrants: { "client-a": ["tenant-a", "tenant-b"] },
      ledger,
    })).toEqual({ ok: false, reason: "not_entitled" });
    expect(readUsage({ identity: null, tenantGrants: TENANT_GRANTS, ledger }))
      .toEqual({ ok: false, reason: "not_entitled" });
  });

  it("returns only the granted tenant's records and honours a confirming hint", () => {
    const ledger = seeded();
    const identity = { clientId: "client-a", sub: "sub-a" };
    const read = readUsage({ identity, tenantGrants: TENANT_GRANTS, ledger });
    expect(read.ok).toBe(true);
    expect(read.tenant).toBe("tenant-a");
    expect(read.records.map((row) => `${row.phase}:${row.requestId}`))
      .toEqual(["decision:a1", "receipt:a1"]);
    expect(read.records.every((row) => row.tenant === "tenant-a")).toBe(true);
    const hinted = readUsage({
      identity: { clientId: "client-a" },
      tenantGrants: { "client-a": ["tenant-a", "tenant-b"] },
      tenant: "tenant-a",
      ledger,
    });
    expect(hinted.ok).toBe(true);
    expect(hinted.records).toHaveLength(2);
    const narrowed = readUsage({
      identity, tenantGrants: TENANT_GRANTS, principalKey: "nobody", ledger,
    });
    expect(narrowed).toMatchObject({ ok: true, tenant: "tenant-a", records: [] });
  });
});

describe("reconcileUsage", () => {
  it("settles a complete chain and lists a denied decision", () => {
    const ledger = createUsageLedger();
    const allow = ledger.record(decision({ requestId: "a1" }));
    ledger.record(receipt({ requestId: "a1", decisionId: allow.decisionId }));
    const deny = ledger.record(decision({
      requestId: null, decision: "deny", reason: "not_entitled",
    }));
    const result = reconcileUsage(ledger.records());
    expect(result.findings).toEqual([
      { requestId: "a1", decisionId: allow.decisionId, state: "settled", reason: null },
      { requestId: null, decisionId: deny.decisionId, state: "denied", reason: "not_entitled" },
    ]);
    expect(result.summary).toEqual({
      total: 2, settled: 1, denied: 1, missing: 0, duplicate: 0, uncertain: 0, truncated: false,
    });
  });

  it("names a dispatch without a receipt and a receipt without a dispatch as missing", () => {
    const ledger = createUsageLedger();
    const allow = ledger.record(decision({ requestId: "a1" }));
    ledger.record(receipt({ requestId: "ghost", decisionId: null }));
    const result = reconcileUsage(ledger.records());
    expect(result.findings).toEqual([
      { requestId: "a1", decisionId: allow.decisionId, state: "missing", reason: "receipt_missing" },
      { requestId: "ghost", decisionId: null, state: "missing", reason: "decision_missing" },
    ]);
    expect(result.summary.missing).toBe(2);
  });

  it("names repeated decisions or receipts for one request as duplicate", () => {
    const ledger = createUsageLedger();
    const allow = ledger.record(decision({ requestId: "a1" }));
    ledger.record(receipt({ requestId: "a1", decisionId: allow.decisionId }));
    ledger.record(receipt({ requestId: "a1", decisionId: allow.decisionId, outcome: "unknown", reason: "unmatched_receipt" }));
    const twice = ledger.record(decision({ requestId: "a2" }));
    ledger.record(decision({ requestId: "a2" }));
    const result = reconcileUsage(ledger.records());
    expect(result.findings).toEqual([
      { requestId: "a1", decisionId: allow.decisionId, state: "duplicate", reason: "duplicate_receipt" },
      { requestId: "a2", decisionId: twice.decisionId, state: "duplicate", reason: "duplicate_decision" },
    ]);
    expect(result.summary.duplicate).toBe(2);
  });

  it("names an unknown outcome or a broken chain as uncertain", () => {
    const ledger = createUsageLedger();
    const timedOut = ledger.record(decision({ requestId: "a1" }));
    ledger.record(receipt({
      requestId: "a1", decisionId: timedOut.decisionId, outcome: "unknown", reason: "fan_down_failed",
    }));
    const crossed = ledger.record(decision({ requestId: "a2" }));
    ledger.record(receipt({ requestId: "a2", decisionId: crossed.decisionId, tenant: "tenant-b" }));
    const swapped = ledger.record(decision({ requestId: "a3" }));
    ledger.record(receipt({ requestId: "a3", decisionId: "someone-else" }));
    const result = reconcileUsage(ledger.records());
    expect(result.findings).toEqual([
      { requestId: "a1", decisionId: timedOut.decisionId, state: "uncertain", reason: "fan_down_failed" },
      { requestId: "a2", decisionId: crossed.decisionId, state: "uncertain", reason: "chain_mismatch" },
      { requestId: "a3", decisionId: swapped.decisionId, state: "uncertain", reason: "chain_mismatch" },
    ]);
    expect(result.summary.uncertain).toBe(3);
  });

  it("reports truncation so a bounded ledger cannot pass as complete", () => {
    const ledger = createUsageLedger({ maxRecords: 1 });
    const allow = ledger.record(decision({ requestId: "a1" }));
    ledger.record(receipt({ requestId: "a1", decisionId: allow.decisionId }));
    const result = reconcileUsage(ledger.records(), { dropped: ledger.stats().dropped });
    expect(result.summary.truncated).toBe(true);
    expect(result.findings).toEqual([
      { requestId: "a1", decisionId: allow.decisionId, state: "missing", reason: "decision_missing" },
    ]);
  });
});
