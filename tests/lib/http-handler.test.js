import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpRequestHandler } from "../../src/lib/http-handler.js";

/** Minimal Node-like ServerResponse mock that records status/headers/body. */
function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || null; return this; },
    end(chunk) { if (chunk !== undefined) this.body += chunk; return this; },
  };
}
const req = (method, url, headers = {}) => ({ method, url, headers });

describe("createMcpRequestHandler", () => {
  let sessions, openSession, fakeTransport, handler;
  beforeEach(() => {
    sessions = new Map();
    fakeTransport = { handleRequest: vi.fn(async (_req, res) => res.writeHead(200).end("mcp")) };
    openSession = vi.fn(async () => fakeTransport);
    handler = createMcpRequestHandler({ checkAuth: () => true, sessions, openSession, toolCount: 66 });
  });

  it("returns 401 with WWW-Authenticate when auth fails on POST /mcp", async () => {
    const h = createMcpRequestHandler({ checkAuth: () => false, sessions, openSession, toolCount: 66 });
    const res = mockRes();
    await h(req("POST", "/mcp", { authorization: "Bearer nope" }), res);
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toBe("Bearer");
    expect(openSession).not.toHaveBeenCalled();
  });

  it("returns 401 when auth fails on GET /mcp", async () => {
    const h = createMcpRequestHandler({ checkAuth: () => false, sessions, openSession, toolCount: 66 });
    const res = mockRes();
    await h(req("GET", "/mcp"), res);
    expect(res.statusCode).toBe(401);
  });

  it("opens a new session and dispatches on POST /mcp without a session id", async () => {
    const res = mockRes();
    await handler(req("POST", "/mcp"), res);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(fakeTransport.handleRequest).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it("reuses an existing session on POST /mcp with a known session id", async () => {
    sessions.set("s1", fakeTransport);
    const res = mockRes();
    await handler(req("POST", "/mcp", { "mcp-session-id": "s1" }), res);
    expect(openSession).not.toHaveBeenCalled();
    expect(fakeTransport.handleRequest).toHaveBeenCalledOnce();
  });

  it("returns 400 on GET /mcp without a known session", async () => {
    const res = mockRes();
    await handler(req("GET", "/mcp", { "mcp-session-id": "unknown" }), res);
    expect(res.statusCode).toBe(400);
    expect(fakeTransport.handleRequest).not.toHaveBeenCalled();
  });

  it("dispatches GET /mcp with a known session", async () => {
    sessions.set("s1", fakeTransport);
    const res = mockRes();
    await handler(req("GET", "/mcp", { "mcp-session-id": "s1" }), res);
    expect(fakeTransport.handleRequest).toHaveBeenCalledOnce();
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
});
