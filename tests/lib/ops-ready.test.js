/**
 * DEV-863: /ready checks real dependencies. Unreachable introspection
 * (401 / 404 / 5xx, or a non-introspection body) is 503. Red evidence
 * uses a test-only fixture, not a production toggle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  READY_PROBE_CACHE_MS,
  checkAllowlists,
  checkIntrospectionReachable,
  checkScopeTable,
  createReadyChecker,
  introspectionProbeOk,
  readyBody,
  runReadyChecks,
} from "../../src/lib/ops-ready.js";
import { createOpsMetrics } from "../../src/lib/ops-metrics.js";
import { createOpsRequestHandler, startOpsListener } from "../../src/lib/ops-listener.js";
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

function mockRes() {
  const response = {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
  };
  response.writeHead = function writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers || null;
    this.headersSent = true;
    return this;
  };
  response.end = function end(chunk) {
    if (chunk !== undefined) this.body += chunk;
    return this;
  };
  response.setHeader = () => {};
  return response;
}

/**
 * Real /ready status-check: GET /ready must be 503 with the introspection
 * check name only. A broken-check fixture that reports ready makes this throw.
 *
 * @param {(req: object, res: object) => Promise<void>} handle
 */
async function assertReadyHttp503(handle) {
  const res = mockRes();
  await handle({ method: "GET", url: "/ready", headers: { host: "127.0.0.1" } }, res);
  expect(res.statusCode).toBe(503);
  expect(JSON.parse(res.body)).toEqual({ status: "not_ready", failed: ["introspection"] });
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it.each([
    [404, { error: "not found" }],
    [500, { error: "unavailable" }],
    [502, { error: "bad gateway" }],
  ])("serves 503 from /ready when introspection returns %s", async (status, body) => {
    const ops = await startOpsListener({
      resolved: { enabled: true, host: "127.0.0.1", port: 0 },
      metrics: createOpsMetrics(),
      readiness: {
        definitions: SCOPED_DEFS,
        sites: READY_SITES,
        inboundCfg: INTROSPECT_CFG,
        fetchFn: async () => jsonRes(status, body),
      },
      exit: (code, reason) => { throw new Error(`ops exited (${code}): ${reason}`); },
      log: () => {},
    });
    expect(ops.started).toBe(true);
    try {
      const res = await fetch(new URL("/ready", `${ops.url}/`));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: "not_ready", failed: ["introspection"] });
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

  it("re-probes /ready after 8s and flips to 200 when introspection recovers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T15:00:00.000Z"));
    let probes = 0;
    let status = 502;
    const fetchFn = async () => {
      probes += 1;
      return status === 200
        ? jsonRes(200, { active: false })
        : jsonRes(status, { error: "down" });
    };
    const ops = await startOpsListener({
      resolved: { enabled: true, host: "127.0.0.1", port: 0 },
      metrics: createOpsMetrics(),
      readiness: {
        definitions: SCOPED_DEFS,
        sites: READY_SITES,
        inboundCfg: INTROSPECT_CFG,
        loopbackBind: true,
        fetchFn,
        cacheMs: READY_PROBE_CACHE_MS,
      },
      exit: (code, reason) => { throw new Error(`ops exited (${code}): ${reason}`); },
      log: () => {},
    });
    expect(ops.started).toBe(true);
    try {
      const failed = await fetch(new URL("/ready", `${ops.url}/`));
      expect(failed.status).toBe(503);
      expect(probes).toBe(1);
      const cached = await fetch(new URL("/ready", `${ops.url}/`));
      expect(cached.status).toBe(503);
      expect(probes).toBe(1);

      status = 200;
      vi.setSystemTime(Date.now() + READY_PROBE_CACHE_MS);
      const recovered = await fetch(new URL("/ready", `${ops.url}/`));
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({ status: "ok" });
      expect(probes).toBe(2);
    } finally {
      await ops.close();
    }
  });

  it("runs the real /ready status check against a stubbed 401 probe", async () => {
    const handle = createOpsRequestHandler({
      metrics: createOpsMetrics(),
      checkReady: () => runReadyChecks({
        definitions: SCOPED_DEFS,
        sites: READY_SITES,
        inboundCfg: INTROSPECT_CFG,
        fetchFn: async () => jsonRes(401, { error: "invalid_client" }),
      }),
    });
    await assertReadyHttp503(handle);

    const broken = createOpsRequestHandler({
      metrics: createOpsMetrics(),
      checkReady: async () => ({ ok: true, failed: [] }),
    });
    await expect(assertReadyHttp503(broken)).rejects.toThrow();
  });
});
