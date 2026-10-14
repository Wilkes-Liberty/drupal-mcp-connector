import { createRateLimiter } from "../../src/lib/rate-limit.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createLegacySessionHandler,
  createMcpRequestHandler,
  LEGACY_SESSION_CAP,
} from "../../src/lib/http-handler.js";
import { getRequestIdentity, LOCAL_OPERATOR } from "../../src/lib/principal.js";

/** Minimal Node-like ServerResponse mock that records status/headers/body. */
function mockRes() {
  const response = {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
    destroyed: false,
    destroyError: null,
    // Presence of `on` keeps the audit finish hook from wrapping the spies
    // below (DEV-858). Real ServerResponse emits finish/close; these tests
    // assert writeHead/end/destroy identity.
    on: vi.fn(),
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
  response.destroy = vi.fn(function destroy(error) {
    this.destroyed = true;
    this.destroyError = error;
    return this;
  });
  return response;
}
const req = (method, url, headers = {}) => ({
  method,
  url,
  headers: { host: "127.0.0.1", ...headers },
});

function bodyReq(body, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    url: "/mcp",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield bytes; },
  };
}

function rawBodyReq(chunks, headers = {}) {
  return {
    method: "POST",
    url: "/mcp",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  };
}

describe("createMcpRequestHandler", () => {
  let fakeTransport, legacyHandler, handler;
  beforeEach(() => {
    fakeTransport = { handleRequest: vi.fn(async (_req, res) => res.writeHead(200).end("mcp")) };
    legacyHandler = vi.fn((request, response, body) => fakeTransport.handleRequest(request, response, body));
    handler = createMcpRequestHandler({
      checkAuth: () => true,
      allowLocalOperator: true,
      modernHandler: vi.fn(),
      legacyHandler,
      toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
      isLegacyRequestFn: async () => true,
    });
  });

  it("returns 401 with WWW-Authenticate when auth fails on POST /mcp", async () => {
    const modernHandler = vi.fn();
    const toWebRequestFn = vi.fn();
    const isLegacyRequestFn = vi.fn();
    const h = createMcpRequestHandler({
      checkAuth: () => false,
      modernHandler,
      legacyHandler,
      toWebRequestFn,
      isLegacyRequestFn,
    });
    const res = mockRes();
    await h(rawBodyReq(["{not-json"], { authorization: "Bearer nope" }), res);
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/^Bearer\b/);
    expect(res.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
    expect(res.headers["WWW-Authenticate"]).toContain("error_description=\"Bearer token required\"");
    expect(modernHandler).not.toHaveBeenCalled();
    expect(legacyHandler).not.toHaveBeenCalled();
    expect(toWebRequestFn).not.toHaveBeenCalled();
    expect(isLegacyRequestFn).not.toHaveBeenCalled();
  });

  it("returns 401 when auth fails on GET /mcp", async () => {
    const h = createMcpRequestHandler({
      checkAuth: () => false,
      modernHandler: vi.fn(),
      legacyHandler,
    });
    const res = mockRes();
    await h(req("GET", "/mcp"), res);
    expect(res.statusCode).toBe(401);
  });

  it("does not classify or dispatch an unauthenticated legacy notification", async () => {
    const modernHandler = vi.fn();
    const legacyHandler = vi.fn();
    const toWebRequestFn = vi.fn();
    const isLegacyRequestFn = vi.fn();
    const h = createMcpRequestHandler({
      checkAuth: () => false,
      modernHandler,
      legacyHandler,
      toWebRequestFn,
      isLegacyRequestFn,
    });
    const res = mockRes();

    await h(bodyReq({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, reason: "test" },
    }), res);

    expect(res.statusCode).toBe(401);
    expect(toWebRequestFn).not.toHaveBeenCalled();
    expect(isLegacyRequestFn).not.toHaveBeenCalled();
    expect(modernHandler).not.toHaveBeenCalled();
    expect(legacyHandler).not.toHaveBeenCalled();
  });

  it("serves /health as JSON without tool data", async () => {
    const res = mockRes();
    await handler(req("GET", "/health"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown paths", async () => {
    const res = mockRes();
    await handler(req("GET", "/nope"), res);
    expect(res.statusCode).toBe(404);
  });

  it("serves protected-resource metadata without authentication", async () => {
    const document = { resource: "https://mcp.example.com/mcp", authorization_servers: ["https://idp.example.com"] };
    const h = createMcpRequestHandler({
      checkAuth: () => false,
      protectedResource: document,
      modernHandler: vi.fn(),
      legacyHandler,
    });
    const res = mockRes();
    await h(req("GET", "/.well-known/oauth-protected-resource/mcp"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(document);
  });

  it("returns 404 for the well-known path when no resource server is configured", async () => {
    const res = mockRes();
    await handler(req("GET", "/.well-known/oauth-protected-resource"), res);
    expect(res.statusCode).toBe(404);
  });

  it("uses the resource-server authenticator and attaches identity", async () => {
    const incoming = req("GET", "/mcp", { authorization: "Bearer good" });
    const authenticate = vi.fn(async () => ({
      ok: true,
      identity: Object.freeze({ sub: "agent-1", scopes: ["mcp_read"] }),
    }));
    const h = createMcpRequestHandler({
      authenticate,
      modernHandler: vi.fn(),
      legacyHandler,
    });
    const res = mockRes();
    await h(incoming, res);
    expect(authenticate).toHaveBeenCalled();
    expect(incoming.mcpIdentity.sub).toBe("agent-1");
    expect(res.statusCode).toBe(405);
    expect(legacyHandler).not.toHaveBeenCalled();
  });

  it("exposes the inbound identity to the request store for discovery", async () => {
    let seen = "unset";
    const identityHandler = vi.fn(async () => {
      seen = getRequestIdentity()?.sub ?? null;
    });
    const incoming = bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const h = createMcpRequestHandler({
      authenticate: async () => ({
        ok: true,
        identity: Object.freeze({ sub: "agent-1", scopes: ["mcp_read"] }),
      }),
      modernHandler: identityHandler,
      legacyHandler: vi.fn(),
      toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
      isLegacyRequestFn: async () => false,
    });
    await h(incoming, mockRes());
    expect(seen).toBe("agent-1");
    expect(getRequestIdentity()).toBeNull();
  });

  it("charges the address bucket for an insufficient-scope 403 so under-scoped bearers cannot introspect for free", async () => {
    const authenticate = vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: { "WWW-Authenticate": "Bearer error=\"insufficient_scope\", scope=\"mcp_read\"" },
      body: "Forbidden",
    }));
    const rateLimiter = {
      peek: vi.fn(() => ({ allowed: true, remaining: 1, retryAfterSec: 0 })),
      check: vi.fn(() => ({ allowed: true, remaining: 0, retryAfterSec: 0 })),
    };
    const modernHandler = vi.fn();
    const h = createMcpRequestHandler({
      authenticate,
      rateLimiter,
      modernHandler,
      legacyHandler: vi.fn(),
      toWebRequestFn: vi.fn(),
    });
    const res = mockRes();
    await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer scoped-wrong" }), res);
    expect(res.statusCode).toBe(403);
    expect(authenticate).toHaveBeenCalledTimes(1);
    // The bearer-present request was only peeked before auth; the 403 then
    // consumes a slot, exactly like a 401 does.
    expect(rateLimiter.peek).toHaveBeenCalledWith("addr:127.0.0.1");
    expect(rateLimiter.check).toHaveBeenCalledTimes(1);
    expect(rateLimiter.check).toHaveBeenCalledWith("addr:127.0.0.1");
    expect(modernHandler).not.toHaveBeenCalled();
  });

  it("reserves address quota atomically so a concurrent bearer burst cannot all reach introspection", async () => {
    let settle;
    const gate = new Promise((resolve) => { settle = resolve; });
    const authenticate = vi.fn(async () => {
      await gate;
      return { ok: false, status: 401, headers: { "WWW-Authenticate": "Bearer error=\"invalid_token\"" }, body: "Unauthorized" };
    });
    const h = createMcpRequestHandler({
      authenticate,
      rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 }),
      modernHandler: vi.fn(),
      legacyHandler: vi.fn(),
      toWebRequestFn: vi.fn(),
    });
    const responses = Array.from({ length: 25 }, () => mockRes());
    const inflight = responses.map((res) =>
      h(bodyReq({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer burst" }), res));
    await new Promise((resolve) => setImmediate(resolve));
    // Only the first request reserved the single slot; the rest were refused
    // before any auth work, while the first introspection was still pending.
    expect(authenticate).toHaveBeenCalledTimes(1);
    settle();
    await Promise.all(inflight);
    const codes = responses.map((res) => res.statusCode).sort((a, b) => a - b);
    expect(codes.filter((c) => c === 401)).toHaveLength(1);
    expect(codes.filter((c) => c === 429)).toHaveLength(24);
  });

  it("charges the address bucket when introspection fails with 503 so an issuer outage cannot be probed for free", async () => {
    const rateLimiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => 0 });
    const authenticate = vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { "Retry-After": "2" },
      body: "Service Unavailable",
    }));
    const h = createMcpRequestHandler({
      authenticate,
      rateLimiter,
      modernHandler: vi.fn(),
      legacyHandler: vi.fn(),
      toWebRequestFn: vi.fn(),
    });
    const codes = [];
    for (let i = 0; i < 4; i += 1) {
      const res = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer outage" }), res);
      codes.push(res.statusCode);
    }
    // Two 503s consumed the two slots; the next two never reached the issuer.
    expect(codes).toEqual([503, 503, 429, 429]);
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it("charges a verified token with no principal to one shared bucket, not to its client address", async () => {
    const principalLimiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    const h = createMcpRequestHandler({
      authenticate: async () => ({ ok: true, identity: { scopes: ["mcp_read"] } }),
      principalLimiter,
      modernHandler: vi.fn(async (req, res) => { res.writeHead(200).end("ok"); }),
      legacyHandler: vi.fn(),
      toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
      isLegacyRequestFn: async () => false,
    });
    const first = mockRes();
    await h({ ...bodyReq({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer anon" }), socket: { remoteAddress: "198.51.100.1" } }, first);
    expect(first.statusCode).toBe(200);
    // Same unidentifiable token from a different address: still over the limit.
    const second = mockRes();
    await h({ ...bodyReq({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer anon" }), socket: { remoteAddress: "198.51.100.2" } }, second);
    expect(second.statusCode).toBe(429);
    expect(principalLimiter.peek("principal:unresolved").allowed).toBe(false);
  });

  it("gives a verified principal its address hold back so only the principal gate charges it", async () => {
    const rateLimiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    const principalLimiter = createRateLimiter({ limit: 100, windowMs: 60_000, now: () => 0 });
    const h = createMcpRequestHandler({
      authenticate: async () => ({ ok: true, identity: { sub: "agent-1", clientId: "c", scopes: ["mcp_read"] } }),
      rateLimiter,
      principalLimiter,
      modernHandler: vi.fn(async (req, res) => { res.writeHead(200).end("ok"); }),
      legacyHandler: vi.fn(),
      toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
      isLegacyRequestFn: async () => false,
    });
    for (let i = 0; i < 3; i += 1) {
      const res = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer good" }), res);
      expect(res.statusCode).toBe(200);
    }
    // Three verified requests, one-per-window address limit: the address
    // bucket was never charged; the principal bucket was.
    expect(rateLimiter.peek("addr:127.0.0.1").allowed).toBe(true);
    expect(principalLimiter.peek('principal:["agent-1","c"]').remaining).toBe(97);
  });

  it("meters a bearer on an unknown path before authentication so it is never a free introspection", async () => {
    const authenticate = vi.fn(async () => ({ ok: true, identity: { sub: "x", scopes: [] } }));
    const denied = { allowed: false, retryAfterSec: 3, remaining: 0 };
    const rateLimiter = { check: vi.fn(() => denied), peek: vi.fn(() => denied), reserve: vi.fn(() => ({ ...denied, commit() {}, release() {} })) };
    const h = createMcpRequestHandler({
      authenticate,
      rateLimiter,
      modernHandler: vi.fn(),
      legacyHandler: vi.fn(),
      toWebRequestFn: vi.fn(),
    });
    for (const url of ["/bogus", "/mcp/extra", "http://evil.example/mcp"]) {
      const res = mockRes();
      await h({ ...bodyReq({}, { authorization: "Bearer any" }), url }, res);
      expect(res.statusCode, url).toBe(429);
    }
    expect(authenticate).not.toHaveBeenCalled();
    // Without a bearer the unknown path charges the address bucket too.
    const res = mockRes();
    await h({ ...bodyReq({}), url: "/bogus" }, res);
    expect(res.statusCode).toBe(429);
    expect(rateLimiter.check).toHaveBeenCalled();
  });

  it("meters a bearer on an unsupported /mcp method before authentication", async () => {
    const authenticate = vi.fn(async () => ({ ok: true, identity: { sub: "x", scopes: [] } }));
    const rateLimiter = {
      check: vi.fn(() => ({ allowed: false, retryAfterSec: 3, remaining: 0 })),
      peek: vi.fn(() => ({ allowed: false, retryAfterSec: 3, remaining: 0 })),
    };
    const h = createMcpRequestHandler({
      authenticate,
      rateLimiter,
      modernHandler: vi.fn(),
      legacyHandler: vi.fn(),
      toWebRequestFn: vi.fn(),
    });
    for (const method of ["PUT", "OPTIONS", "PATCH"]) {
      const res = mockRes();
      await h({ ...bodyReq({}, { authorization: "Bearer any" }), method }, res);
      expect(res.statusCode, method).toBe(429);
    }
    expect(authenticate).not.toHaveBeenCalled();
    // And without a bearer the address bucket is charged for the same verbs.
    const res = mockRes();
    await h({ ...bodyReq({}), method: "PUT" }, res);
    expect(res.statusCode).toBe(429);
    expect(rateLimiter.check).toHaveBeenCalled();
  });

  it("returns the authenticator challenge without reading the body", async () => {
    const modernHandler = vi.fn();
    const toWebRequestFn = vi.fn();
    const h = createMcpRequestHandler({
      authenticate: async () => ({
        ok: false,
        status: 401,
        headers: { "WWW-Authenticate": "Bearer realm=\"mcp\", error=\"invalid_token\"" },
        body: "Unauthorized",
      }),
      modernHandler,
      legacyHandler,
      toWebRequestFn,
    });
    const res = mockRes();
    await h(rawBodyReq(["{not-json"], { authorization: "Bearer nope" }), res);
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("invalid_token");
    expect(modernHandler).not.toHaveBeenCalled();
    expect(toWebRequestFn).not.toHaveBeenCalled();
  });

  it("returns 401 when the authenticator throws", async () => {
    const modernHandler = vi.fn();
    const h = createMcpRequestHandler({
      authenticate: async () => { throw new Error("corrupt revocation"); },
      modernHandler,
      legacyHandler,
    });
    const res = mockRes();
    await h(req("POST", "/mcp", { authorization: "Bearer x" }), res);
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("invalid_token");
    expect(modernHandler).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the rate limiter denies", async () => {
    const rateLimiter = { check: vi.fn(() => ({ allowed: false, retryAfterSec: 7, remaining: 0 })) };
    const h = createMcpRequestHandler({
      checkAuth: () => true,
      allowLocalOperator: true,
      modernHandler: vi.fn(),
      legacyHandler,
      rateLimiter,
      clientKey: () => "ip",
    });
    const res = mockRes();
    await h(req("POST", "/mcp"), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("7");
    expect(legacyHandler).not.toHaveBeenCalled();
  });

  it("rate-limits unauthenticated /mcp before auth so missing-token floods are throttled", async () => {
    const authenticate = vi.fn(async () => ({ ok: false, status: 401, headers: {}, body: "Unauthorized" }));
    const rateLimiter = { check: () => ({ allowed: false, retryAfterSec: 1, remaining: 0 }) };
    const h = createMcpRequestHandler({
      authenticate,
      modernHandler: vi.fn(),
      legacyHandler,
      rateLimiter,
      clientKey: () => "ip",
    });
    const res = mockRes();
    await h(req("POST", "/mcp"), res);
    expect(res.statusCode).toBe(429); // limiter precedes the 401
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("does not rate-limit the /health probe", async () => {
    const rateLimiter = { check: vi.fn(() => ({ allowed: false, retryAfterSec: 1 })) };
    const h = createMcpRequestHandler({
      checkAuth: () => true,
      allowLocalOperator: true,
      modernHandler: vi.fn(),
      legacyHandler,
      rateLimiter,
      clientKey: () => "ip",
    });
    const res = mockRes();
    await h(req("GET", "/health"), res);
    expect(res.statusCode).toBe(200);
    expect(rateLimiter.check).not.toHaveBeenCalled();
  });

  it("reads one authenticated POST body and sends it only to the classified modern handler", async () => {
    const modernHandler = vi.fn(async (_req, res, body) => {
      expect(body).toEqual({ jsonrpc: "2.0", id: 1, method: "server/discover" });
      res.writeHead(200).end("modern");
    });
    const legacyHandler = vi.fn();
    const toWebRequestFn = vi.fn(async () => new Request("http://127.0.0.1/mcp", { method: "POST" }));
    const isLegacyRequestFn = vi.fn(async () => false);
    const h = createMcpRequestHandler({
      checkAuth: () => true,
      allowLocalOperator: true,
      modernHandler,
      legacyHandler,
      toWebRequestFn,
      isLegacyRequestFn,
    });
    const res = mockRes();

    await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "server/discover" }), res);

    expect(toWebRequestFn).toHaveBeenCalledOnce();
    expect(isLegacyRequestFn).toHaveBeenCalledOnce();
    expect(modernHandler).toHaveBeenCalledOnce();
    expect(legacyHandler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("authenticates DELETE before routing it directly to the legacy session handler", async () => {
    const modernHandler = vi.fn();
    const legacyHandler = vi.fn(async (_req, res) => res.writeHead(204).end());
    const toWebRequestFn = vi.fn();
    const isLegacyRequestFn = vi.fn();
    const unauthenticated = createMcpRequestHandler({
      checkAuth: () => false,
      modernHandler,
      legacyHandler,
      toWebRequestFn,
      isLegacyRequestFn,
    });
    const denied = mockRes();
    await unauthenticated(req("DELETE", "/mcp"), denied);
    expect(denied.statusCode).toBe(401);
    expect(legacyHandler).not.toHaveBeenCalled();

    const authenticated = createMcpRequestHandler({
      checkAuth: () => true,
      allowLocalOperator: true,
      modernHandler,
      legacyHandler,
      toWebRequestFn,
      isLegacyRequestFn,
    });
    const allowed = mockRes();
    await authenticated(req("DELETE", "/mcp", { "mcp-session-id": "legacy-1" }), allowed);
    expect(allowed.statusCode).toBe(204);
    expect(legacyHandler).toHaveBeenCalledOnce();
    expect(toWebRequestFn).not.toHaveBeenCalled();
    expect(isLegacyRequestFn).not.toHaveBeenCalled();
    expect(modernHandler).not.toHaveBeenCalled();
  });

  describe("unexpected routing failures", () => {
    const internalSecret = "postgres://sentinel:do-not-echo@internal.example/token-123";

    it.each([
      ["request conversion", "conversion"],
      ["classification", "classification"],
      ["modern dispatch", "modern"],
      ["legacy dispatch", "legacy"],
    ])("does not expose an internal message from %s and invokes at most one arm", async (_label, failureAt) => {
      const modernHandler = vi.fn(async () => {
        if (failureAt === "modern") throw new Error(internalSecret);
      });
      const legacyHandler = vi.fn(async () => {
        if (failureAt === "legacy") throw new Error(internalSecret);
      });
      const toWebRequestFn = vi.fn(async () => {
        if (failureAt === "conversion") throw new Error(internalSecret);
        return new Request("http://127.0.0.1/mcp", { method: "POST" });
      });
      const isLegacyRequestFn = vi.fn(async () => {
        if (failureAt === "classification") throw new Error(internalSecret);
        return failureAt === "legacy";
      });
      const onError = vi.fn(() => { throw new Error("diagnostic sink failed"); });
      const h = createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler,
        legacyHandler,
        toWebRequestFn,
        isLegacyRequestFn,
        onError,
      });
      const res = mockRes();

      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }), res);

      expect.soft(res.statusCode).toBe(500);
      expect.soft(res.body).toBe("Internal Server Error");
      expect.soft(res.body).not.toContain(internalSecret);
      expect(modernHandler).toHaveBeenCalledTimes(failureAt === "modern" ? 1 : 0);
      expect(legacyHandler).toHaveBeenCalledTimes(failureAt === "legacy" ? 1 : 0);
      expect(onError).toHaveBeenCalledWith({
        stage: failureAt === "conversion" ? "request-conversion"
          : failureAt === "classification" ? "classification"
            : `${failureAt}-dispatch`,
      });
      expect(JSON.stringify(onError.mock.calls)).not.toContain(internalSecret);
    });

    it.each(["GET", "DELETE"])("contains an unexpected authenticated legacy %s failure", async (method) => {
      const legacyHandler = vi.fn(async () => { throw new Error(internalSecret); });
      const onError = vi.fn();
      const h = createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler: vi.fn(),
        legacyHandler,
        onError,
      });
      const res = mockRes();

      await h(req(method, "/mcp", { "mcp-session-id": "legacy-1" }), res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toBe("Internal Server Error");
      expect(res.body).not.toContain(internalSecret);
      expect(legacyHandler).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith({ stage: "legacy-dispatch" });
    });

    it("contains a legacy notification dispatch failure before headers", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn(async () => { throw new Error(internalSecret); });
      const onError = vi.fn();
      const h = createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler,
        legacyHandler,
        toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
        isLegacyRequestFn: async () => true,
        onError,
      });
      const res = mockRes();

      await h(bodyReq({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }), res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toBe("Internal Server Error");
      expect(res.body).not.toContain(internalSecret);
      expect(legacyHandler).toHaveBeenCalledOnce();
      expect(modernHandler).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith({ stage: "legacy-dispatch" });
    });

    it("destroys a failed legacy notification after headers without a second response", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn(async (_req, res) => {
        res.writeHead(202);
        throw new Error(internalSecret);
      });
      const h = createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler,
        legacyHandler,
        toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
        isLegacyRequestFn: async () => true,
      });
      const res = mockRes();

      await h(bodyReq({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }), res);

      expect(res.writeHead).toHaveBeenCalledOnce();
      expect(res.end).not.toHaveBeenCalled();
      expect(res.destroy).toHaveBeenCalledOnce();
      expect(res.destroy).toHaveBeenCalledWith();
      expect(modernHandler).not.toHaveBeenCalled();
    });

    it("terminates safely without a second response when the selected arm rejects after headers", async () => {
      const internalError = new Error(internalSecret);
      const modernHandler = vi.fn(async (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        throw internalError;
      });
      const legacyHandler = vi.fn();
      const h = createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler,
        legacyHandler,
        toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
        isLegacyRequestFn: async () => false,
      });
      const res = mockRes();

      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }), res);

      expect(modernHandler).toHaveBeenCalledOnce();
      expect(legacyHandler).not.toHaveBeenCalled();
      expect.soft(res.writeHead).toHaveBeenCalledOnce();
      expect.soft(res.end).not.toHaveBeenCalled();
      expect.soft(res.destroy).toHaveBeenCalledOnce();
      expect.soft(res.destroy).toHaveBeenCalledWith();
    });
  });

  describe("dual-era construction", () => {
    it.each([
      ["modern", { legacyHandler: vi.fn() }],
      ["legacy", { modernHandler: vi.fn() }],
    ])("rejects a missing %s handler instead of inferring legacy-only routing", (_missing, handlers) => {
      expect(() => createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        ...handlers,
      })).toThrow(/modernHandler and legacyHandler must be configured together/);
    });
  });

  describe("injected predicate construction (DEV-866 L2)", () => {
    const predicates = [
      "originAllowedFn",
      "protocolVersionSupportedFn",
      "acceptOkFn",
      "isUnauthenticatedRouteFn",
      "sessionlessMethodRefusedFn",
      "isJsonRpcBatchFn",
    ];

    it.each(predicates)("throws at construction when %s is null", (name) => {
      expect(() => createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler: vi.fn(),
        legacyHandler: vi.fn(),
        [name]: null,
      })).toThrow(new RegExp(`${name} must be a function`));
    });

    it.each(predicates)("throws at construction when %s is not a function", (name) => {
      expect(() => createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler: vi.fn(),
        legacyHandler: vi.fn(),
        [name]: true,
      })).toThrow(new RegExp(`${name} must be a function`));
    });
  });

  describe("controlled body errors", () => {
    it("rejects a declared oversized body before reading or dispatching", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn();
      const request = rawBodyReq(["{}"], { "content-length": "99" });
      const iterator = vi.spyOn(request, Symbol.asyncIterator);
      const h = createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler,
        legacyHandler,
        maxBodyBytes: 8,
      });
      const res = mockRes();

      await h(request, res);

      expect(res.statusCode).toBe(413);
      expect(iterator).not.toHaveBeenCalled();
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    });

    it("returns a stable 413 without dispatch when the bounded body overflows", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn();
      const h = createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler,
        legacyHandler,
        maxBodyBytes: 8,
      });
      const res = mockRes();

      await h(rawBodyReq(["{\"jsonrpc\":", "\"2.0\"}"]), res);

      expect(res.statusCode).toBe(413);
      expect(res.body).toBe("Request body exceeds the configured limit");
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    });

    it("returns a stable 400 without dispatch for malformed JSON", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn();
      const h = createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler,
        legacyHandler,
      });
      const res = mockRes();

      await h(rawBodyReq(["{not-json"]), res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toBe("Malformed JSON request body");
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    });
  });

  describe("Streamable HTTP conformance (DEV-840)", () => {
    function authed(overrides = {}) {
      return createMcpRequestHandler({
        checkAuth: () => true,
        allowLocalOperator: true,
        modernHandler: vi.fn(async (_req, res) => res.writeHead(200).end("modern")),
        legacyHandler: vi.fn(async (_req, res) => res.writeHead(200).end("legacy")),
        toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
        isLegacyRequestFn: async () => false,
        allowedOrigins: ["https://app.example.com"],
        ...overrides,
      });
    }

    it("returns 401 for unauthenticated GET and DELETE before Origin or dispatch", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn();
      const h = createMcpRequestHandler({
        checkAuth: () => false,
        modernHandler,
        legacyHandler,
        allowedOrigins: ["https://app.example.com"],
      });
      for (const method of ["GET", "DELETE"]) {
        const res = mockRes();
        await h(req(method, "/mcp", { origin: "https://evil.example" }), res);
        expect(res.statusCode, method).toBe(401);
        expect(res.headers["WWW-Authenticate"]).toMatch(/^Bearer\b/);
      }
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    });

    it("returns 403 for a present Origin that is not on the allowlist", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn();
      const h = authed({ modernHandler, legacyHandler });
      const res = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://evil.example" }), res);
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.message).toMatch(/origin/i);
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    });

    it("allows a missing Origin and an allowlisted Origin", async () => {
      const h = authed();
      const missing = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }), missing);
      expect(missing.statusCode).toBe(200);

      const allowed = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { origin: "https://app.example.com" }), allowed);
      expect(allowed.statusCode).toBe(200);
    });

    it("refuses Cursor lookalikes and lets listed origins pass preflight and POST (DEV-953)", async () => {
      const modernHandler = vi.fn(async (_req, res) => res.writeHead(200).end("modern"));
      const legacyHandler = vi.fn();
      const h = authed({
        modernHandler,
        legacyHandler,
        allowedOrigins: ["https://cursor.com", "https://www.cursor.com"],
      });
      for (const origin of [
        "https://cursor.com.evil.example",
        "https://www.cursor.com.evil.example",
        "http://cursor.com",
        "http://www.cursor.com",
        "https://evil.cursor.com",
      ]) {
        const res = mockRes();
        await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin }), res);
        expect(res.statusCode, origin).toBe(403);
        expect(JSON.parse(res.body).error.message, origin).toMatch(/origin/i);
        expect(modernHandler).not.toHaveBeenCalled();
        expect(legacyHandler).not.toHaveBeenCalled();
      }

      for (const origin of ["https://cursor.com", "https://www.cursor.com"]) {
        const preflight = mockRes();
        await h(req("OPTIONS", "/mcp", { origin }), preflight);
        expect(preflight.statusCode, origin).not.toBe(403);
      }
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();

      for (const origin of ["https://cursor.com", "https://www.cursor.com"]) {
        const posted = mockRes();
        await h(bodyReq({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { origin }), posted);
        expect(posted.statusCode, origin).toBe(200);
      }
      expect(modernHandler).toHaveBeenCalledTimes(2);
      expect(legacyHandler).not.toHaveBeenCalled();
    });

    it("refuses every present Origin when the handler allowlist is empty (DEV-953)", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn();
      const h = authed({
        modernHandler,
        legacyHandler,
        allowedOrigins: [],
      });
      for (const origin of ["https://cursor.com", "https://www.cursor.com"]) {
        const res = mockRes();
        await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin }), res);
        expect(res.statusCode, origin).toBe(403);
        expect(JSON.parse(res.body).error.message, origin).toMatch(/origin/i);
      }
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    });

    it("returns 401 for a missing identity before Origin or dispatch (DEV-953)", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn();
      const h = createMcpRequestHandler({
        checkAuth: () => false,
        modernHandler,
        legacyHandler,
        allowedOrigins: ["https://cursor.com"],
      });
      for (const method of ["OPTIONS", "POST"]) {
        const res = mockRes();
        await h(req(method, "/mcp", { origin: "https://cursor.com" }), res);
        expect(res.statusCode, method).toBe(401);
        expect(res.headers["WWW-Authenticate"]).toMatch(/^Bearer\b/);
      }
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    });

    it("returns 403 for a Host that is not on the allowlist (DEV-861)", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn();
      const h = authed({
        modernHandler,
        legacyHandler,
        allowedHosts: ["mcp.example.com"],
      });
      const res = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { host: "evil.example" }), res);
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error.message).toMatch(/host/i);
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    });

    it("allows a Host on the allowlist and refuses a missing Host (DEV-861)", async () => {
      const h = authed({ allowedHosts: ["mcp.example.com", "127.0.0.1"] });
      const allowed = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { host: "mcp.example.com" }), allowed);
      expect(allowed.statusCode).toBe(200);

      const missing = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { host: "" }), missing);
      expect(missing.statusCode).toBe(403);
      expect(JSON.parse(missing.body).error.message).toMatch(/host/i);
    });

    it("returns 401 for an unauthenticated request before the Host guard (DEV-861 / DEV-877)", async () => {
      const modernHandler = vi.fn();
      const h = createMcpRequestHandler({
        checkAuth: () => false,
        modernHandler,
        legacyHandler: vi.fn(),
        allowedHosts: ["mcp.example.com"],
        resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      });
      const res = mockRes();
      await h(req("POST", "/mcp", { host: "evil.example", authorization: "Bearer nope" }), res);
      expect(res.statusCode).toBe(401);
      expect(res.headers["WWW-Authenticate"]).toMatch(/^Bearer\b/);
      expect(res.headers["WWW-Authenticate"]).toContain("resource_metadata=");
      expect(modernHandler).not.toHaveBeenCalled();
    });

    it("returns 400 for an unsupported MCP-Protocol-Version before dispatch", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn();
      const h = authed({ modernHandler, legacyHandler });
      const res = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
        "mcp-protocol-version": "2099-01-01",
      }), res);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({
        error: { code: -32022, data: { supported: expect.arrayContaining(["2026-07-28"]) } },
      });
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    });

    it("returns 400 for a present but empty MCP-Protocol-Version", async () => {
      const modernHandler = vi.fn();
      const h = authed({ modernHandler });
      const res = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
        "mcp-protocol-version": "",
      }), res);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: -32022 } });
      expect(modernHandler).not.toHaveBeenCalled();
    });

    it("returns 406 for a present but empty Accept header", async () => {
      const modernHandler = vi.fn();
      const h = authed({ modernHandler });
      const res = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { accept: "" }), res);
      expect(res.statusCode).toBe(406);
      expect(modernHandler).not.toHaveBeenCalled();
    });

    it("returns 405 for authenticated GET and DELETE without a session", async () => {
      const legacyHandler = vi.fn();
      const h = authed({ legacyHandler });
      for (const method of ["GET", "DELETE"]) {
        const res = mockRes();
        await h(req(method, "/mcp"), res);
        expect(res.statusCode, method).toBe(405);
        expect(res.headers.Allow).toBe("POST");
      }
      expect(legacyHandler).not.toHaveBeenCalled();
    });

    it("returns 406 when Accept lists neither JSON nor SSE", async () => {
      const modernHandler = vi.fn();
      const h = authed({ modernHandler });
      const res = mockRes();
      await h(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
        accept: "text/html",
      }), res);
      expect(res.statusCode).toBe(406);
      expect(modernHandler).not.toHaveBeenCalled();
    });

    it("returns 400 for a JSON-RPC batch before classification", async () => {
      const modernHandler = vi.fn();
      const legacyHandler = vi.fn();
      const h = authed({ modernHandler, legacyHandler });
      const res = mockRes();
      await h(bodyReq([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]), res);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe(-32600);
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    });
  });
});

describe("createLegacySessionHandler", () => {
  it("throws at construction when sessionPrincipalKeyFn is not a function", () => {
    expect(() => createLegacySessionHandler({
      buildServer: vi.fn(),
      sessionPrincipalKeyFn: null,
    })).toThrow(/sessionPrincipalKeyFn must be a function/);
  });

  const principalA = Object.freeze({ sub: "agent-a", clientId: "client-a" });
  const principalB = Object.freeze({ sub: "agent-b", clientId: "client-b" });
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "1.0.0" },
    },
  };

  function identReq(method, headers = {}, identity = LOCAL_OPERATOR) {
    return { method, url: "/mcp", headers, mcpIdentity: identity };
  }

  function setup(mode = "serve", extras = {}) {
    const sessions = new Map();
    const server = { connect: vi.fn(async () => {}) };
    const buildServer = vi.fn(() => server);
    const transports = [];
    let n = 0;
    const transportFactory = vi.fn((options) => {
      const id = `legacy-${++n}`;
      const transport = {
        sessionId: undefined,
        close: vi.fn(async () => {
          transport.onclose?.();
        }),
        handleRequest: vi.fn(async (_req, res, body) => {
          if (body?.method === "initialize") {
            transport.sessionId = id;
            options.onsessioninitialized(id);
          }
          res.writeHead(200).end("legacy");
        }),
      };
      transports.push(transport);
      return transport;
    });
    const handler = createLegacySessionHandler({
      buildServer,
      sessions,
      mode,
      transportFactory,
      ...extras,
    });
    return {
      handler,
      sessions,
      server,
      buildServer,
      transportFactory,
      transports,
      get transport() { return transports[transports.length - 1]; },
    };
  }

  it("creates a session only for initialize and reuses it for later requests", async () => {
    const state = setup();
    const initialized = mockRes();
    await state.handler(identReq("POST"), initialized, initialize);
    expect(initialized.statusCode).toBe(200);
    expect(state.buildServer).toHaveBeenCalledWith({ era: "legacy" });
    expect(state.server.connect).toHaveBeenCalledWith(state.transport);
    expect(state.sessions.get("legacy-1")).toEqual({
      transport: state.transport,
      principalKey: "local-operator",
      lastUsed: expect.any(Number),
    });

    const reused = mockRes();
    await state.handler(identReq("POST", { "mcp-session-id": "legacy-1" }), reused, {
      jsonrpc: "2.0", id: 2, method: "tools/list",
    });
    const notified = mockRes();
    await state.handler(identReq("POST", { "mcp-session-id": "legacy-1" }), notified, {
      jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "test" },
    });
    const streamed = mockRes();
    await state.handler(identReq("GET", { "mcp-session-id": "legacy-1" }), streamed);
    expect(state.transportFactory).toHaveBeenCalledOnce();
    expect(state.transport.handleRequest).toHaveBeenCalledTimes(4);
    expect(state.transport.handleRequest).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ method: "POST" }),
      notified,
      expect.objectContaining({ method: "notifications/cancelled" })
    );
    expect(state.transport.handleRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ method: "GET" }),
      streamed,
      undefined
    );
  });

  it("refuses cross-principal session reuse and terminates on DELETE", async () => {
    const state = setup();
    const initialized = mockRes();
    await state.handler(identReq("POST", {}, principalA), initialized, initialize);
    expect(initialized.statusCode).toBe(200);
    expect(state.sessions.has("legacy-1")).toBe(true);

    const hijack = mockRes();
    await state.handler(identReq("POST", { "mcp-session-id": "legacy-1" }, principalB), hijack, {
      jsonrpc: "2.0", id: 2, method: "tools/list",
    });
    expect(hijack.statusCode).toBe(403);
    expect(state.transport.handleRequest).toHaveBeenCalledOnce();

    const closed = mockRes();
    await state.handler(identReq("DELETE", { "mcp-session-id": "legacy-1" }, principalA), closed);
    expect(closed.statusCode).toBe(200);
    expect(state.sessions.has("legacy-1")).toBe(false);

    const expired = mockRes();
    await state.handler(identReq("POST", { "mcp-session-id": "legacy-1" }, principalA), expired, {
      jsonrpc: "2.0", id: 3, method: "tools/list",
    });
    expect(expired.statusCode).toBe(404);
  });

  it("rejects sessionless non-initialize and unknown sessions without opening one", async () => {
    const state = setup();
    const missing = mockRes();
    await state.handler(req("POST", "/mcp"), missing, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(missing.statusCode).toBe(400);

    const unknown = mockRes();
    await state.handler(req("POST", "/mcp", { "mcp-session-id": "not-there" }), unknown, {
      jsonrpc: "2.0", id: 3, method: "tools/list",
    });
    expect(unknown.statusCode).toBe(404);
    expect(state.transportFactory).not.toHaveBeenCalled();
  });

  it("reject mode denies all legacy requests", async () => {
    const state = setup("reject");
    const res = mockRes();
    await state.handler(identReq("POST"), res, initialize);
    expect(res.statusCode).toBe(400);
    const get = mockRes();
    await state.handler(identReq("GET", { "mcp-session-id": "legacy-1" }), get);
    expect(get.statusCode).toBe(405);
    expect(state.transportFactory).not.toHaveBeenCalled();
  });

  it("defaults to the 128 session cap used by the server-tools cache", () => {
    expect(LEGACY_SESSION_CAP).toBe(128);
  });

  it("throws at construction when maxSessions is not a positive integer", () => {
    expect(() => createLegacySessionHandler({
      buildServer: vi.fn(),
      maxSessions: 0,
    })).toThrow(/maxSessions must be a positive integer/);
  });

  it("evicts the least-recently-used session when the cap is reached", async () => {
    let t = 0;
    const state = setup("serve", { maxSessions: 2, idleMs: 60_000, now: () => ++t });
    await state.handler(identReq("POST"), mockRes(), initialize);
    await state.handler(identReq("POST"), mockRes(), initialize);
    expect([...state.sessions.keys()]).toEqual(["legacy-1", "legacy-2"]);

    await state.handler(identReq("POST"), mockRes(), initialize);
    expect([...state.sessions.keys()]).toEqual(["legacy-2", "legacy-3"]);
    expect(state.transports[0].close).toHaveBeenCalled();

    const stale = mockRes();
    await state.handler(identReq("POST", { "mcp-session-id": "legacy-1" }), stale, {
      jsonrpc: "2.0", id: 9, method: "tools/list",
    });
    expect(stale.statusCode).toBe(404);
  });

  it("keeps a reused session when a later initialize hits the cap", async () => {
    let t = 0;
    const state = setup("serve", { maxSessions: 2, idleMs: 60_000, now: () => ++t });
    await state.handler(identReq("POST"), mockRes(), initialize);
    await state.handler(identReq("POST"), mockRes(), initialize);
    await state.handler(identReq("POST", { "mcp-session-id": "legacy-1" }), mockRes(), {
      jsonrpc: "2.0", id: 2, method: "tools/list",
    });
    await state.handler(identReq("POST"), mockRes(), initialize);
    expect([...state.sessions.keys()]).toEqual(["legacy-1", "legacy-3"]);
    expect(state.transports[1].close).toHaveBeenCalled();
  });

  it("evicts an idle session on the next request", async () => {
    let t = 1_000;
    const state = setup("serve", { maxSessions: 8, idleMs: 100, now: () => t });
    await state.handler(identReq("POST"), mockRes(), initialize);
    expect(state.sessions.has("legacy-1")).toBe(true);

    t = 1_101;
    const stale = mockRes();
    await state.handler(identReq("POST", { "mcp-session-id": "legacy-1" }), stale, {
      jsonrpc: "2.0", id: 2, method: "tools/list",
    });
    expect(stale.statusCode).toBe(404);
    expect(state.sessions.has("legacy-1")).toBe(false);
    expect(state.transports[0].close).toHaveBeenCalled();
  });

  it("close() terminates every leftover transport", async () => {
    const state = setup();
    await state.handler(identReq("POST"), mockRes(), initialize);
    await state.handler(identReq("POST"), mockRes(), initialize);
    expect(state.sessions.size).toBe(2);
    await state.handler.close();
    expect(state.sessions.size).toBe(0);
    expect(state.transports[0].close).toHaveBeenCalled();
    expect(state.transports[1].close).toHaveBeenCalled();
  });
});
