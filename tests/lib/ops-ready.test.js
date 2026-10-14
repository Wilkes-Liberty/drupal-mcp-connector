/**
 * DEV-863: /ready checks real dependencies. Unreachable introspection
 * is 503. The introspection guard can be flipped so this assertion goes red.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  checkAllowlists,
  checkIntrospectionReachable,
  checkScopeTable,
  OPS_READY_INTROSPECTION_GUARD,
  readyBody,
  runReadyChecks,
  setOpsReadyIntrospectionGuard,
} from "../../src/lib/ops-ready.js";
import { createOpsMetrics } from "../../src/lib/ops-metrics.js";
import { startOpsListener } from "../../src/lib/ops-listener.js";
import { TOOL_SCOPE_TABLE } from "../../src/lib/tool-scopes.js";

const SCOPED_DEFS = Object.keys(TOOL_SCOPE_TABLE).map((name) => ({ name }));

describe("ready checks (DEV-863)", () => {
  afterEach(() => {
    setOpsReadyIntrospectionGuard(true);
  });

  it("passes scope_table when every registered tool has a row", () => {
    expect(checkScopeTable(SCOPED_DEFS)).toBe(true);
    expect(checkScopeTable([{ name: "drupal_eval_unscoped" }])).toBe(false);
  });

  it("passes well-formed allowlists and fails a malformed entity list", () => {
    expect(checkAllowlists({
      sites: [{ security: { preset: "production-strict" } }],
      inboundCfg: { resource: "https://mcp.example.com/mcp", allowedHosts: [], allowedOrigins: [] },
    })).toBe(true);
    expect(checkAllowlists({
      sites: [{ security: { allowedEntityTypes: "node" } }],
    })).toBe(false);
  });

  it("returns 503 when introspection is unreachable", async () => {
    const result = await runReadyChecks({
      definitions: SCOPED_DEFS,
      sites: [{ security: { preset: "production-strict" } }],
      inboundCfg: {
        issuer: "https://idp.example.com",
        audience: "https://mcp.example.com/mcp",
        introspectionUrl: "https://idp.example.com/introspect",
        introspectionTimeoutMs: 50,
      },
      fetchFn: async () => {
        throw new Error("issuer down");
      },
    });
    expect(result).toEqual({ ok: false, failed: ["introspection"] });
    expect(readyBody(result)).toEqual({ status: "not_ready", failed: ["introspection"] });
    expect(JSON.stringify(readyBody(result))).not.toMatch(/idp\.example|secret|token=/i);
  });

  it("serves 503 from the ops listener when introspection is unreachable", async () => {
    const ops = await startOpsListener({
      resolved: { enabled: true, host: "127.0.0.1", port: 0 },
      metrics: createOpsMetrics(),
      readiness: {
        definitions: SCOPED_DEFS,
        sites: [{ security: { preset: "production-strict" } }],
        inboundCfg: {
          issuer: "https://idp.example.com",
          audience: "https://mcp.example.com/mcp",
          introspectionUrl: "https://idp.example.com/introspect",
          introspectionTimeoutMs: 50,
        },
        fetchFn: async () => {
          throw new Error("issuer down");
        },
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

  it("fails when the introspection guard is disabled (red evidence)", async () => {
    expect(OPS_READY_INTROSPECTION_GUARD.required).toBe(true);
    setOpsReadyIntrospectionGuard(false);
    const reachable = await checkIntrospectionReachable({
      url: "https://idp.example.com/introspect",
      timeoutMs: 20,
      fetchFn: async () => {
        throw new Error("issuer down");
      },
    });
    expect(reachable).toBe(true);
    const result = await runReadyChecks({
      definitions: SCOPED_DEFS,
      sites: [{ security: { preset: "production-strict" } }],
      inboundCfg: {
        issuer: "https://idp.example.com",
        audience: "https://mcp.example.com/mcp",
        introspectionUrl: "https://idp.example.com/introspect",
      },
      fetchFn: async () => {
        throw new Error("issuer down");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.failed).not.toContain("introspection");
  });
});
