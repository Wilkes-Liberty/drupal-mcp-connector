import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import {
  HTTP_AUDIT_CODES,
  attachHttpAudit,
  buildHttpAuditRow,
  classifyHttpAuditCode,
  createHttpAuditWriter,
  markHttpAuditHostRefused,
  markHttpAuditOriginRefused,
  markHttpAuditTenant,
  requestHasAuthorization,
  resolveRequestId,
  sanitizeHttpAuditRow,
} from "../../src/lib/http-audit.js";
import { createLegacySessionHandler, createMcpRequestHandler } from "../../src/lib/http-handler.js";

function mockRes() {
  const response = {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
    destroyed: false,
  };
  response.writeHead = vi.fn(function writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers || null;
    this.headersSent = true;
    return this;
  });
  response.end = vi.fn(function end(chunk) {
    if (chunk !== undefined) this.body += chunk;
    return this;
  });
  response.destroy = vi.fn(function destroy() {
    this.destroyed = true;
    return this;
  });
  return response;
}

const req = (method, url, headers = {}) => ({
  method,
  url,
  headers: { host: "127.0.0.1", ...headers },
});

describe("classifyHttpAuditCode", () => {
  it("maps the closed denial set", () => {
    expect(classifyHttpAuditCode({ status: 401, hasAuthorization: false })).toBe("unauthenticated");
    expect(classifyHttpAuditCode({ status: 401, hasAuthorization: true })).toBe("invalid_token");
    expect(classifyHttpAuditCode({ status: 429 })).toBe("rate_limited");
    expect(classifyHttpAuditCode({ status: 403, originDenied: true })).toBe("bad_origin");
    expect(classifyHttpAuditCode({ status: 403, hostDenied: true })).toBe("bad_host");
    expect(classifyHttpAuditCode({ status: 403 })).toBe("forbidden");
    expect(classifyHttpAuditCode({ status: 200 })).toBe("ok");
    expect(HTTP_AUDIT_CODES).toEqual([
      "unauthenticated", "invalid_token", "rate_limited", "bad_origin", "bad_host",
      "forbidden", "aborted", "ok",
    ]);
  });

  it("does not let originDenied override the finished status", () => {
    expect(classifyHttpAuditCode({ status: 200, originDenied: true })).toBe("ok");
    expect(classifyHttpAuditCode({ status: 429, originDenied: true })).toBe("rate_limited");
    expect(classifyHttpAuditCode({
      status: 401, originDenied: true, hasAuthorization: false,
    })).toBe("unauthenticated");
  });
});

describe("sanitizeHttpAuditRow", () => {
  it("drops secret keys and unknown fields", () => {
    const row = sanitizeHttpAuditRow({
      timestamp: "t",
      route: "/mcp",
      method: "POST",
      status: 401,
      code: "invalid_token",
      requestId: "r1",
      authorization: "Bearer SECRET",
      cookie: "SECRET",
      body: "SECRET",
      headers: { authorization: "Bearer SECRET" },
      token: "SECRET",
      extra: "nope",
    });
    expect(row).toEqual({
      timestamp: "t",
      route: "/mcp",
      method: "POST",
      status: 401,
      code: "invalid_token",
      requestId: "r1",
    });
    expect(JSON.stringify(row)).not.toContain("SECRET");
  });

  it("redacts a sentinel that leaked into a kept field", () => {
    const row = sanitizeHttpAuditRow({
      timestamp: "t",
      route: "/mcp",
      method: "POST",
      status: 401,
      code: "invalid_token",
      requestId: "SENTINEL",
    }, ["SENTINEL"]);
    expect(JSON.stringify(row)).not.toContain("SENTINEL");
    expect(row.requestId).toBe("[redacted]");
  });

  it("rejects an open-coded denial string", () => {
    expect(sanitizeHttpAuditRow({ code: "disk-path-/etc/shadow" }).code).toBe("forbidden");
  });
});

describe("resolveRequestId / requestHasAuthorization", () => {
  it("honors a short x-request-id and ignores a token-shaped one", () => {
    expect(resolveRequestId(req("POST", "/mcp", { "x-request-id": "abc" }))).toBe("abc");
    const leaked = resolveRequestId(req("POST", "/mcp", {
      "x-request-id": "tok",
      authorization: "Bearer tok",
    }));
    expect(leaked).not.toBe("tok");
    expect(requestHasAuthorization(req("POST", "/mcp"))).toBe(false);
    expect(requestHasAuthorization(req("POST", "/mcp", { authorization: "Bearer x" }))).toBe(true);
  });
});

describe("createHttpAuditWriter", () => {
  it("never throws when the sink throws", () => {
    const writer = createHttpAuditWriter({
      sink: () => { throw new Error("disk full"); },
    });
    expect(() => writer.write({
      route: "/mcp", method: "POST", status: 401, code: "unauthenticated", requestId: "r",
    })).not.toThrow();
    expect(writer.rows).toHaveLength(1);
  });
});

describe("attachHttpAudit", () => {
  it("writes exactly one row when end and finish both fire", () => {
    const writer = createHttpAuditWriter({ sink: () => {} });
    const request = req("POST", "/mcp");
    const res = Object.assign(new EventEmitter(), mockRes());
    attachHttpAudit(request, res, writer);
    attachHttpAudit(request, res, writer);
    res.writeHead(401);
    res.end("Unauthorized");
    res.emit("finish");
    res.emit("close");
    expect(writer.rows).toHaveLength(1);
    expect(writer.rows[0].code).toBe("unauthenticated");
  });

  it("includes principal only when the request already has an identity", () => {
    const writer = createHttpAuditWriter({ sink: () => {} });
    const request = req("POST", "/mcp");
    request.mcpIdentity = { sub: "user-1", tenant: "tenant-a" };
    const res = mockRes();
    res.statusCode = 200;
    attachHttpAudit(request, res, writer);
    res.end("ok");
    expect(writer.rows[0]).toMatchObject({
      code: "ok", principal: "user-1", tenant: "tenant-a",
    });
  });

  it("does not record a disconnect before writeHead as ok", () => {
    const writer = createHttpAuditWriter({ sink: () => {} });
    const request = req("POST", "/mcp");
    const res = Object.assign(new EventEmitter(), mockRes());
    res.statusCode = 200;
    attachHttpAudit(request, res, writer);
    res.emit("close");
    expect(writer.rows).toHaveLength(1);
    expect(writer.rows[0]).toMatchObject({ code: "aborted", status: 0 });
    res.emit("finish");
    expect(writer.rows).toHaveLength(1);
  });
});

describe("buildHttpAuditRow", () => {
  it("never copies authorization, cookie, or body into the row", () => {
    const request = req("POST", "/mcp?x=1", {
      authorization: "Bearer leaked-token",
      cookie: "session=leaked-token",
    });
    const res = { statusCode: 401 };
    const row = buildHttpAuditRow(request, res, { requestId: "rid" });
    expect(JSON.stringify(row)).not.toContain("leaked-token");
    expect(row).toMatchObject({
      route: "/mcp", method: "POST", status: 401, code: "invalid_token", requestId: "rid",
    });
  });

  it("does not label auxiliary routes bad_origin without a handler mark", () => {
    expect(buildHttpAuditRow(
      req("GET", "/health", { origin: "https://evil.example" }),
      { statusCode: 200 },
    ).code).toBe("ok");
    expect(buildHttpAuditRow(
      req("GET", "/usage", { origin: "https://evil.example" }),
      { statusCode: 429 },
    ).code).toBe("rate_limited");
    expect(buildHttpAuditRow(
      req("GET", "/assessor", { origin: "https://evil.example" }),
      { statusCode: 403 },
    ).code).toBe("forbidden");
  });

  it("labels bad_origin only when the handler marked the refusal on a 403", () => {
    const refused = req("POST", "/mcp");
    markHttpAuditOriginRefused(refused);
    expect(buildHttpAuditRow(refused, { statusCode: 403 }).code).toBe("bad_origin");
    expect(buildHttpAuditRow(req("POST", "/mcp"), { statusCode: 403 }).code).toBe("forbidden");
  });

  it("labels bad_host only when the handler marked the refusal on a 403", () => {
    const refused = req("POST", "/mcp");
    markHttpAuditHostRefused(refused);
    expect(buildHttpAuditRow(refused, { statusCode: 403 }).code).toBe("bad_host");
    expect(buildHttpAuditRow(req("POST", "/mcp"), { statusCode: 403 }).code).toBe("forbidden");
  });
});

describe("createMcpRequestHandler audit finish hook", () => {
  const legacyHandler = vi.fn();

  function handler(overrides = {}) {
    const writer = createHttpAuditWriter({ sink: () => {} });
    return {
      writer,
      handle: createMcpRequestHandler({
        checkAuth: () => false,
        modernHandler: vi.fn(),
        legacyHandler,
        auditWriter: writer,
        ...overrides,
      }),
    };
  }

  it("records unauthenticated, rate_limited, bad_origin, and ok", async () => {
    const missing = handler();
    const missingRes = mockRes();
    await missing.handle(req("POST", "/mcp"), missingRes);
    expect(missingRes.statusCode).toBe(401);
    expect(missing.writer.rows).toHaveLength(1);
    expect(missing.writer.rows[0].code).toBe("unauthenticated");

    const limited = handler({
      rateLimiter: { check: () => ({ allowed: false, retryAfterSec: 1 }) },
    });
    const limitedRes = mockRes();
    await limited.handle(req("POST", "/mcp"), limitedRes);
    expect(limitedRes.statusCode).toBe(429);
    expect(limited.writer.rows[0].code).toBe("rate_limited");

    const origin = handler({
      checkAuth: () => true,
      allowLocalOperator: true,
      allowedOrigins: ["https://app.example"],
    });
    const originRes = mockRes();
    await origin.handle(req("POST", "/mcp", { origin: "https://evil.example" }), originRes);
    expect(originRes.statusCode).toBe(403);
    expect(origin.writer.rows[0].code).toBe("bad_origin");

    const allowed = handler({
      checkAuth: () => true,
      allowLocalOperator: true,
      allowedOrigins: ["https://app.example"],
      modernHandler: vi.fn(),
      legacyHandler: createLegacySessionHandler({
        buildServer: async () => ({ connect: async () => {} }),
        mode: "reject",
      }),
    });
    const okRes = mockRes();
    await allowed.handle(req("GET", "/health", { origin: "https://evil.example" }), okRes);
    expect(okRes.statusCode).toBe(200);
    expect(allowed.writer.rows[0].code).toBe("ok");
  });

  it("audits Cursor lookalikes as bad_origin and listed origins as passing (DEV-953)", async () => {
    const lookalikes = [
      "https://cursor.com.evil.example",
      "https://www.cursor.com.evil.example",
      "http://cursor.com",
    ];
    for (const origin of lookalikes) {
      const refused = handler({
        checkAuth: () => true,
        allowLocalOperator: true,
        allowedOrigins: ["https://cursor.com", "https://www.cursor.com"],
      });
      const res = mockRes();
      await refused.handle(req("POST", "/mcp", { origin }), res);
      expect(res.statusCode, origin).toBe(403);
      expect(refused.writer.rows).toHaveLength(1);
      expect(refused.writer.rows[0].code, origin).toBe("bad_origin");
      expect(refused.writer.rows[0].status, origin).toBe(403);
    }

    const listed = handler({
      checkAuth: () => true,
      allowLocalOperator: true,
      allowedOrigins: ["https://cursor.com", "https://www.cursor.com"],
      modernHandler: vi.fn(async (_req, res) => res.writeHead(200).end("modern")),
      legacyHandler: createLegacySessionHandler({
        buildServer: async () => ({ connect: async () => {} }),
        mode: "reject",
      }),
    });
    for (const origin of ["https://cursor.com", "https://www.cursor.com"]) {
      const preflight = mockRes();
      await listed.handle(req("OPTIONS", "/mcp", { origin }), preflight);
      expect(preflight.statusCode, origin).not.toBe(403);
    }
    expect(listed.writer.rows.every((row) => row.code !== "bad_origin")).toBe(true);

    const missing = handler({ allowedOrigins: ["https://cursor.com", "https://www.cursor.com"] });
    const missingRes = mockRes();
    await missing.handle(req("POST", "/mcp", { origin: "https://www.cursor.com" }), missingRes);
    expect(missingRes.statusCode).toBe(401);
    expect(missing.writer.rows[0].code).toBe("unauthenticated");
    expect(missing.writer.rows[0].status).toBe(401);

    const empty = handler({
      checkAuth: () => true,
      allowLocalOperator: true,
      allowedOrigins: [],
    });
    const emptyRes = mockRes();
    await empty.handle(req("POST", "/mcp", { origin: "https://cursor.com" }), emptyRes);
    expect(emptyRes.statusCode).toBe(403);
    expect(empty.writer.rows[0].code).toBe("bad_origin");
  });

  it("labels bad_origin only from the handler's own refusal", async () => {
    // A disallowed Origin on a route that never enforces Origin is not a refusal.
    const health = handler({ allowedOrigins: ["https://app.example"] });
    const healthRes = mockRes();
    await health.handle(req("GET", "/health", { origin: "https://evil.example" }), healthRes);
    expect(healthRes.statusCode).toBe(200);
    expect(health.writer.rows[0].code).toBe("ok");

    // Auth runs before the Origin guard (DEV-840): an unauthenticated request
    // with a disallowed Origin is recorded as the 401 it received.
    const unauth = handler({ allowedOrigins: ["https://app.example"] });
    const unauthRes = mockRes();
    await unauth.handle(req("POST", "/mcp", { origin: "https://evil.example" }), unauthRes);
    expect(unauthRes.statusCode).toBe(401);
    expect(unauth.writer.rows[0].code).toBe("unauthenticated");
    expect(unauth.writer.rows[0].status).toBe(401);
  });

  it("records bad_host from the handler Host refusal after auth (DEV-861)", async () => {
    const host = handler({
      checkAuth: () => true,
      allowLocalOperator: true,
      allowedHosts: ["mcp.example.com"],
    });
    const hostRes = mockRes();
    await host.handle(req("POST", "/mcp", { host: "evil.example" }), hostRes);
    expect(hostRes.statusCode).toBe(403);
    expect(host.writer.rows[0].code).toBe("bad_host");

    const unauth = handler({ allowedHosts: ["mcp.example.com"] });
    const unauthRes = mockRes();
    await unauth.handle(req("POST", "/mcp", { host: "evil.example" }), unauthRes);
    expect(unauthRes.statusCode).toBe(401);
    expect(unauth.writer.rows[0].code).toBe("unauthenticated");
  });

  it("records a client abort before headers as aborted, not ok", () => {
    const writer = createHttpAuditWriter({ sink: () => {} });
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: false, writableFinished: false });
    attachHttpAudit(req("POST", "/mcp"), res, writer);
    res.emit("close");
    expect(writer.rows).toHaveLength(1);
    expect(writer.rows[0].code).toBe("aborted");
    expect(writer.rows[0].status).toBe(0);
    // A late 401 cannot rewrite history, and no second row appears.
    res.statusCode = 401;
    res.headersSent = true;
    res.emit("finish");
    expect(writer.rows).toHaveLength(1);
  });

  it("keeps a normal finish after close as the real status", () => {
    const writer = createHttpAuditWriter({ sink: () => {} });
    const res = Object.assign(new EventEmitter(), { statusCode: 429, headersSent: true, writableFinished: true });
    attachHttpAudit(req("POST", "/mcp"), res, writer);
    res.emit("finish");
    res.emit("close");
    expect(writer.rows).toHaveLength(1);
    expect(writer.rows[0].code).toBe("rate_limited");
  });

  it("carries a tenant and an origin refusal that the handler marked on the request", () => {
    const request = req("GET", "/usage");
    request.mcpIdentity = { sub: "sub-a", clientId: "client-a" };
    markHttpAuditTenant(request, "tenant-alpha");
    const row = buildHttpAuditRow(request, { statusCode: 200 });
    expect(row.principal).toBe("sub-a");
    expect(row.tenant).toBe("tenant-alpha");

    const refused = req("POST", "/mcp", { origin: "https://evil.example" });
    markHttpAuditOriginRefused(refused);
    expect(buildHttpAuditRow(refused, { statusCode: 403 }).code).toBe("bad_origin");
  });

  it("keeps a 401 when the writer throws", async () => {
    const { handle } = handler({
      auditWriter: { write: () => { throw new Error("audit disk full"); } },
    });
    const res = mockRes();
    await handle(req("POST", "/mcp"), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("Unauthorized");
  });

  it("does not write when the writer is disabled", async () => {
    const sink = vi.fn();
    const { handle } = handler({ auditWriter: null });
    const res = mockRes();
    await handle(req("POST", "/mcp"), res);
    expect(res.statusCode).toBe(401);
    expect(sink).not.toHaveBeenCalled();
  });
});
