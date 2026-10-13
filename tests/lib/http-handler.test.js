import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLegacySessionHandler, createMcpRequestHandler } from "../../src/lib/http-handler.js";
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
      toolCount: 66,
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
      toolCount: 66,
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
      toolCount: 66,
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
      toolCount: 66,
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
      toolCount: 66,
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
      toolCount: 66,
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
      toolCount: 66,
      toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
      isLegacyRequestFn: async () => false,
    });
    await h(incoming, mockRes());
    expect(seen).toBe("agent-1");
    expect(getRequestIdentity()).toBeNull();
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
      toolCount: 66,
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
      toolCount: 66,
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
      toolCount: 66,
      rateLimiter,
      clientKey: () => "ip",
    });
    const res = mockRes();
    await h(req("POST", "/mcp"), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("7");
    expect(legacyHandler).not.toHaveBeenCalled();
  });

  it("rate-limits before auth so brute-force attempts are throttled", async () => {
    const rateLimiter = { check: () => ({ allowed: false, retryAfterSec: 1, remaining: 0 }) };
    const h = createMcpRequestHandler({
      checkAuth: () => false,
      modernHandler: vi.fn(),
      legacyHandler,
      toolCount: 66,
      rateLimiter,
      clientKey: () => "ip",
    });
    const res = mockRes();
    await h(req("POST", "/mcp", { authorization: "Bearer bad" }), res);
    expect(res.statusCode).toBe(429); // limiter precedes the 401
  });

  it("does not rate-limit the /health probe", async () => {
    const rateLimiter = { check: vi.fn(() => ({ allowed: false, retryAfterSec: 1 })) };
    const h = createMcpRequestHandler({
      checkAuth: () => true,
      allowLocalOperator: true,
      modernHandler: vi.fn(),
      legacyHandler,
      toolCount: 66,
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
      toolCount: 66,
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
      toolCount: 66,
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
      toolCount: 66,
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
        toolCount: 66,
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
        toolCount: 66,
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
        toolCount: 66,
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
        toolCount: 66,
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
        toolCount: 66,
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
        toolCount: 66,
        ...handlers,
      })).toThrow(/modernHandler and legacyHandler must be configured together/);
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
        toolCount: 66,
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
        toolCount: 66,
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
        toolCount: 66,
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
        toolCount: 66,
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
        toolCount: 66,
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
        toolCount: 66,
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

  function setup(mode = "serve") {
    const sessions = new Map();
    const server = { connect: vi.fn(async () => {}) };
    const buildServer = vi.fn(() => server);
    let transport;
    const transportFactory = vi.fn((options) => {
      transport = {
        sessionId: undefined,
        close: vi.fn(async () => {
          transport.onclose?.();
        }),
        handleRequest: vi.fn(async (_req, res, body) => {
          if (body?.method === "initialize") {
            transport.sessionId = "legacy-1";
            options.onsessioninitialized("legacy-1");
          }
          res.writeHead(200).end("legacy");
        }),
      };
      return transport;
    });
    const handler = createLegacySessionHandler({
      buildServer,
      sessions,
      mode,
      transportFactory,
    });
    return { handler, sessions, server, buildServer, transportFactory, get transport() { return transport; } };
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
});
