/**
 * DEV-863: mesh-only ops listener. The public MCP handler keeps 401/404
 * for /ready and /metrics. Each guard can be flipped so the assertion
 * goes red.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMcpRequestHandler, isUnauthenticatedRoute } from "../../src/lib/http-handler.js";
import { createConnectorServerFactory } from "../../src/lib/mcp-server.js";
import { startHttpsTransport } from "../../src/lib/https-startup.js";
import { createOpsMetrics } from "../../src/lib/ops-metrics.js";
import {
  createOpsRequestHandler,
  isOpsPath,
  OPS_PUBLIC_ROUTE_GUARD,
  publicListenerRefusesOpsPath,
  setOpsPublicRouteGuard,
  startOpsListener,
} from "../../src/lib/ops-listener.js";
import { TOOL_SCOPE_TABLE } from "../../src/lib/tool-scopes.js";

const INDEX_PATH = fileURLToPath(new URL("../../src/index.js", import.meta.url));
const SCOPED_DEFS = Object.keys(TOOL_SCOPE_TABLE).map((name) => ({ name }));

function mockRes() {
  const response = {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
    on: () => {},
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

const req = (method, url, headers = {}) => ({
  method,
  url,
  headers: { host: "127.0.0.1", ...headers },
});

function publicHandler(overrides = {}) {
  return createMcpRequestHandler({
    checkAuth: () => true,
    allowLocalOperator: true,
    modernHandler: async (_req, res) => { res.writeHead(200).end("mcp"); },
    legacyHandler: async (_req, res) => { res.writeHead(200).end("mcp"); },
    toolCount: 0,
    ...overrides,
  });
}

function networkPublicHandler(overrides = {}) {
  return createMcpRequestHandler({
    checkAuth: () => false,
    allowLocalOperator: false,
    modernHandler: async () => {},
    legacyHandler: async () => {},
    toolCount: 0,
    ...overrides,
  });
}

describe("ops paths", () => {
  it("names only /ready and /metrics", () => {
    expect(isOpsPath("/ready")).toBe(true);
    expect(isOpsPath("/metrics")).toBe(true);
    expect(isOpsPath("/ready?x=1")).toBe(true);
    expect(isOpsPath("/health")).toBe(false);
    expect(isOpsPath("/mcp")).toBe(false);
    expect(isUnauthenticatedRoute("GET", "/ready")).toBe(false);
    expect(isUnauthenticatedRoute("GET", "/metrics")).toBe(false);
  });
});

describe("public listener refuses /ready and /metrics (DEV-863)", () => {
  afterEach(() => {
    setOpsPublicRouteGuard(true);
  });

  it("returns 401 without a token and 404 after auth, never readiness or prometheus", async () => {
    const closed = networkPublicHandler();
    for (const path of ["/ready", "/metrics"]) {
      const unauthorized = mockRes();
      await closed(req("GET", path), unauthorized);
      expect({ path, status: unauthorized.statusCode }).toEqual({ path, status: 401 });
      expect(unauthorized.body).not.toContain("not_ready");
      expect(unauthorized.body).not.toContain("mcp_http_requests_total");
      expect(unauthorized.body).not.toMatch(/# TYPE /);
    }

    const open = publicHandler();
    for (const path of ["/ready", "/metrics"]) {
      const allowed = mockRes();
      await open(req("GET", path), allowed);
      expect({ path, status: allowed.statusCode }).toEqual({ path, status: 404 });
      expect(allowed.body).toBe("Not found");
      expect(allowed.body).not.toContain("mcp_http_requests_total");
    }
  });

  it("keeps GET /health as the public liveness probe", async () => {
    const handle = networkPublicHandler();
    const res = mockRes();
    await handle(req("GET", "/health"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("a live public listener answers 401 or 404 for /ready and /metrics", async () => {
    const dummyServer = createConnectorServerFactory({
      serverInfo: { name: "ops-public", version: "0" },
      tools: { definitions: [], list: async () => [], call: async () => ({}) },
      resources: { definitions: [], read: async () => ({}) },
      prompts: { definitions: [], get: () => [] },
    });
    const result = await startHttpsTransport({
      bindHost: "127.0.0.1",
      port: 0,
      allowHttp: true,
      inboundCfg: { issuer: "", audience: "" },
      buildServer: dummyServer,
      toolCount: 0,
      exit: (code, reason) => { throw new Error(`startup exited (${code}): ${reason}`); },
      log: () => {},
    });
    expect(result.started).toBe(true);
    try {
      for (const path of ["/ready", "/metrics"]) {
        const res = await fetch(new URL(path, result.url));
        expect([401, 404]).toContain(res.status);
        const text = await res.text();
        expect(text).not.toContain("mcp_http_requests_total");
        expect(text).not.toContain("\"failed\"");
        expect(text).not.toMatch(/# TYPE /);
      }
      const health = await fetch(new URL("/health", result.url));
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });
    } finally {
      await result.close();
    }
  });

  it("fails when the public-route guard is disabled (red evidence)", async () => {
    expect(OPS_PUBLIC_ROUTE_GUARD.required).toBe(true);
    expect(publicListenerRefusesOpsPath("/ready")).toBe(true);
    setOpsPublicRouteGuard(false);
    expect(publicListenerRefusesOpsPath("/ready")).toBe(false);
    const handle = networkPublicHandler();
    const ready = mockRes();
    await handle(req("GET", "/ready"), ready);
    expect(ready.statusCode).toBe(200);
    expect(JSON.parse(ready.body)).toEqual({ status: "ok" });
    const metrics = mockRes();
    await handle(req("GET", "/metrics"), metrics);
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("# broken");
  });
});

describe("ops listener serves /ready and /metrics", () => {
  it("is disabled when MCP_OPS_LISTEN is unset", async () => {
    const result = await startOpsListener({
      env: {},
      config: {},
      metrics: createOpsMetrics(),
      log: () => {},
    });
    expect(result.started).toBe(false);
    expect(result.server).toBeUndefined();
  });

  it("serves 200 /ready and prometheus /metrics on loopback", async () => {
    const metrics = createOpsMetrics();
    metrics.beginRequest();
    metrics.finishRequest({ path: "/mcp", status: 401, hasAuthorization: false });
    const ops = await startOpsListener({
      resolved: { enabled: true, host: "127.0.0.1", port: 0 },
      metrics,
      readiness: {
        definitions: SCOPED_DEFS,
        sites: [{ security: { preset: "production-strict" } }],
        inboundCfg: {},
        loopbackBind: true,
      },
      exit: (code, reason) => { throw new Error(`ops exited (${code}): ${reason}`); },
      log: () => {},
    });
    expect(ops.started).toBe(true);
    try {
      const ready = await fetch(new URL("/ready", `${ops.url}/`));
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ok" });
      const scraped = await fetch(new URL("/metrics", `${ops.url}/`));
      expect(scraped.status).toBe(200);
      expect(scraped.headers.get("content-type")).toMatch(/text\/plain/);
      const text = await scraped.text();
      expect(text).toContain("mcp_http_requests_total");
      expect(text).toContain("mcp_http_in_flight");
      const missing = await fetch(new URL("/mcp", `${ops.url}/`));
      expect(missing.status).toBe(404);
    } finally {
      await ops.close();
    }
  });

  it("createOpsRequestHandler 404s unknown methods and paths", async () => {
    const handle = createOpsRequestHandler({
      metrics: createOpsMetrics(),
      checkReady: async () => ({ ok: true, failed: [] }),
    });
    const res = mockRes();
    await handle(req("POST", "/ready"), res);
    expect(res.statusCode).toBe(404);
  });
});

describe("src/index.js wires the ops listener (DEV-863)", () => {
  it("documents MCP_OPS_LISTEN and starts the listener only after resolveOpsListen", () => {
    const source = readFileSync(INDEX_PATH, "utf8");
    expect(source).toMatch(/MCP_OPS_LISTEN/);
    expect(source).toMatch(/resolveOpsListen/);
    expect(source).toMatch(/startOpsListener/);
    expect(source).toMatch(/createOpsMetrics/);
    expect(source).toMatch(/metrics,/);
  });
});
