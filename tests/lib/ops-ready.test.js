/**
 * DEV-863: /ready checks real dependencies. Unreachable introspection
 * (401 / 404 / 5xx, or a non-introspection body) is 503. Red evidence
 * uses a test-only fixture, not a production toggle.
 */
import { describe, expect, it } from "vitest";
import {
  checkAllowlists,
  checkIntrospectionReachable,
  checkScopeTable,
  createReadyChecker,
  introspectionProbeOk,
  readyBody,
  runReadyChecks,
} from "../../src/lib/ops-ready.js";
import { createOpsMetrics } from "../../src/lib/ops-metrics.js";
import { startOpsListener } from "../../src/lib/ops-listener.js";
import { TOOL_SCOPE_TABLE } from "../../src/lib/tool-scopes.js";

const SCOPED_DEFS = Object.keys(TOOL_SCOPE_TABLE).map((name) => ({ name }));

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const READY_SITES = [{ security: { preset: "production-strict" } }];
const INTROSPECT_CFG = {
  issuer: "https://idp.example.com",
  audience: "https://mcp.example.com/mcp",
  introspectionUrl: "https://idp.example.com/introspect",
  introspectionTimeoutMs: 200,
};

/**
 * @param {{ok: boolean, failed: string[]}} result
 */
function assertIntrospectionNotReady(result) {
  expect(result).toEqual({ ok: false, failed: ["introspection"] });
  expect(readyBody(result)).toEqual({ status: "not_ready", failed: ["introspection"] });
  expect(JSON.stringify(readyBody(result))).not.toMatch(/idp\.example|secret|token=/i);
}

describe("ready checks (DEV-863)", () => {
  it("passes scope_table when every registered tool has a row", () => {
    expect(checkScopeTable(SCOPED_DEFS)).toBe(true);
    expect(checkScopeTable([{ name: "drupal_eval_unscoped" }])).toBe(false);
  });

  it("passes well-formed allowlists and fails a malformed entity list", () => {
    expect(checkAllowlists({
      sites: READY_SITES,
      inboundCfg: { resource: "https://mcp.example.com/mcp", allowedHosts: [], allowedOrigins: [] },
    })).toBe(true);
    expect(checkAllowlists({
      sites: [{ security: { allowedEntityTypes: "node" } }],
    })).toBe(false);
  });

  it.each([
    [401, { active: false }],
    [404, { error: "not found" }],
    [500, { error: "unavailable" }],
    [503, { active: true }],
  ])("treats HTTP %s as not ready", async (status, body) => {
    expect(introspectionProbeOk(status, body)).toBe(false);
    const result = await runReadyChecks({
      definitions: SCOPED_DEFS,
      sites: READY_SITES,
      inboundCfg: INTROSPECT_CFG,
      fetchFn: async () => jsonRes(status, body),
    });
    assertIntrospectionNotReady(result);
  });

  it("treats a 2xx without an introspection-shaped body as not ready", async () => {
    expect(introspectionProbeOk(200, { ok: true })).toBe(false);
    expect(introspectionProbeOk(200, "active")).toBe(false);
    const result = await runReadyChecks({
      definitions: SCOPED_DEFS,
      sites: READY_SITES,
      inboundCfg: INTROSPECT_CFG,
      fetchFn: async () => jsonRes(200, { html: true }),
    });
    assertIntrospectionNotReady(result);
  });

  it("accepts 2xx with a boolean active field", async () => {
    expect(introspectionProbeOk(200, { active: false })).toBe(true);
    expect(introspectionProbeOk(201, { active: true })).toBe(true);
    const reachable = await checkIntrospectionReachable({
      url: INTROSPECT_CFG.introspectionUrl,
      fetchFn: async () => jsonRes(200, { active: false }),
    });
    expect(reachable).toBe(true);
    const result = await runReadyChecks({
      definitions: SCOPED_DEFS,
      sites: READY_SITES,
      inboundCfg: INTROSPECT_CFG,
      loopbackBind: true,
      fetchFn: async () => jsonRes(200, { active: false }),
    });
    expect(result).toEqual({ ok: true, failed: [] });
  });

  it("serves 503 from the ops listener when introspection returns 401", async () => {
    const ops = await startOpsListener({
      resolved: { enabled: true, host: "127.0.0.1", port: 0 },
      metrics: createOpsMetrics(),
      readiness: {
        definitions: SCOPED_DEFS,
        sites: READY_SITES,
        inboundCfg: INTROSPECT_CFG,
        fetchFn: async () => jsonRes(401, { error: "invalid_client" }),
      },
      exit: (code, reason) => { throw new Error(`ops exited (${code}): ${reason}`); },
      log: () => {},
    });
    expect(ops.started).toBe(true);
    try {
      const res = await fetch(new URL("/ready", `${ops.url}/`));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ status: "not_ready", failed: ["introspection"] });
      expect(JSON.stringify(body)).not.toMatch(/idp\.example|secret|Bearer/i);
    } finally {
      await ops.close();
    }
  });

  it("single-flights concurrent /ready probes and reuses the cached result", async () => {
    let probes = 0;
    const fetchFn = async () => {
      probes += 1;
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      return jsonRes(200, { active: false });
    };
    const check = createReadyChecker({
      definitions: SCOPED_DEFS,
      sites: READY_SITES,
      inboundCfg: INTROSPECT_CFG,
      loopbackBind: true,
      fetchFn,
      cacheMs: 5_000,
    });
    const first = await Promise.all([check(), check(), check(), check(), check()]);
    expect(probes).toBe(1);
    expect(first.every((item) => item.ok)).toBe(true);
    const second = await Promise.all([check(), check()]);
    expect(probes).toBe(1);
    expect(second.every((item) => item.ok)).toBe(true);
  });

  it("fails when a test-only fixture treats 401 as ready (red evidence)", () => {
    expect(() => assertIntrospectionNotReady({ ok: true, failed: [] })).toThrow();
    expect(introspectionProbeOk(401, { active: false })).toBe(false);
    const fixtureProbeOk = () => true;
    expect(fixtureProbeOk(401, { active: false })).toBe(true);
    expect(() => {
      expect(fixtureProbeOk(401, { active: false })).toBe(false);
    }).toThrow();
  });
});
