import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLegacySessionHandler, createMcpRequestHandler } from "../../src/lib/http-handler.js";

/** Minimal Node-like ServerResponse mock that records status/headers/body. */
function mockRes() {
  const response = {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
    destroyed: false,
    destroyError: null,
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
const req = (method, url, headers = {}) => ({ method, url, headers });

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
    expect(res.headers["WWW-Authenticate"]).toBe("Bearer");
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

  it("serves /health as JSON with the tool count", async () => {
    const res = mockRes();
    await handler(req("GET", "/health"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok", tools: 66 });
  });

  it("returns 404 for unknown paths", async () => {
    const res = mockRes();
    await handler(req("GET", "/nope"), res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 429 with Retry-After when the rate limiter denies", async () => {
    const rateLimiter = { check: vi.fn(() => ({ allowed: false, retryAfterSec: 7, remaining: 0 })) };
    const h = createMcpRequestHandler({
      checkAuth: () => true,
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
      modernHandler,
      legacyHandler,
      toolCount: 66,
      toWebRequestFn,
      isLegacyRequestFn,
    });
    const allowed = mockRes();
    await authenticated(req("DELETE", "/mcp"), allowed);
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
        modernHandler: vi.fn(),
        legacyHandler,
        toolCount: 66,
        onError,
      });
      const res = mockRes();

      await h(req(method, "/mcp"), res);

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
});

describe("createLegacySessionHandler", () => {
  function setup(mode = "serve") {
    const sessions = new Map();
    const server = { connect: vi.fn(async () => {}) };
    const buildServer = vi.fn(() => server);
    let transport;
    const transportFactory = vi.fn((options) => {
      transport = {
        sessionId: undefined,
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
    await state.handler(req("POST", "/mcp"), initialized, initialize);
    expect(initialized.statusCode).toBe(200);
    expect(state.buildServer).toHaveBeenCalledWith({ era: "legacy" });
    expect(state.server.connect).toHaveBeenCalledWith(state.transport);
    expect(state.sessions.get("legacy-1")).toBe(state.transport);

    const reused = mockRes();
    await state.handler(req("POST", "/mcp", { "mcp-session-id": "legacy-1" }), reused, {
      jsonrpc: "2.0", id: 2, method: "tools/list",
    });
    const notified = mockRes();
    await state.handler(req("POST", "/mcp", { "mcp-session-id": "legacy-1" }), notified, {
      jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "test" },
    });
    const streamed = mockRes();
    await state.handler(req("GET", "/mcp", { "mcp-session-id": "legacy-1" }), streamed);
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
    await state.handler(req("POST", "/mcp"), res, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1.0.0" },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(state.transportFactory).not.toHaveBeenCalled();
  });
});
