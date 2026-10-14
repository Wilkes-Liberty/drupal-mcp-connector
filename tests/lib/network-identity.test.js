/**
 * DEV-845: a network request with no resolved identity is refused before
 * dispatch. Stdio remains the local-operator path.
 */

import { describe, expect, it, vi } from "vitest";
import {
  NON_LOOPBACK_UNAUTHENTICATED_REASON,
  resolveInboundAuthMode,
} from "../../src/lib/http-auth.js";
import {
  createMcpRequestHandler,
  isUnauthenticatedRoute,
} from "../../src/lib/http-handler.js";
import {
  LOCAL_OPERATOR,
  filterToolsByPrincipal,
  getRequestIdentity,
  runWithIdentity,
} from "../../src/lib/principal.js";

function mockRes() {
  const response = {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
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
  return response;
}

function bodyReq(body, headers = {}, url = "/mcp") {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    url,
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield bytes; },
  };
}

function req(method, url, headers = {}) {
  return { method, url, headers, socket: { remoteAddress: "127.0.0.1" } };
}

function networkHandler(overrides = {}) {
  return createMcpRequestHandler({
    checkAuth: () => true,
    modernHandler: vi.fn(async (_req, res) => res.writeHead(200).end("modern")),
    legacyHandler: vi.fn(async (_req, res) => res.writeHead(200).end("legacy")),
    toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
    isLegacyRequestFn: async () => false,
    ...overrides,
  });
}

const MCP_METHODS = [
  ["initialize", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }],
  ["tools/list", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }],
  ["tools/call", {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "drupal_list_nodes", arguments: {} },
  }],
];

describe("resolveInboundAuthMode — DEV-845 startup fatal", () => {
  it("refuses a non-loopback bind with allow-unauthenticated and names the reason", () => {
    const decision = resolveInboundAuthMode({
      bindHost: "0.0.0.0",
      allowUnauth: true,
      sharedToken: "",
      resourceServer: { issuer: "", audience: "" },
    });
    expect(decision.mode).toBe("fatal");
    expect(decision.reason).toBe(NON_LOOPBACK_UNAUTHENTICATED_REASON);
    expect(decision.reason).toMatch(/non-loopback/i);
    expect(decision.reason).toMatch(/MCP_ALLOW_UNAUTHENTICATED/);
  });

  it("still allows explicit unauthenticated loopback", () => {
    expect(resolveInboundAuthMode({
      bindHost: "127.0.0.1",
      allowUnauth: true,
    }).mode).toBe("unauthenticated");
  });

  it("still allows unauthenticated loopback without the opt-in flag", () => {
    expect(resolveInboundAuthMode({
      bindHost: "127.0.0.1",
      allowUnauth: false,
      sharedToken: "",
    }).mode).toBe("unauthenticated");
  });
});

describe("HTTP handler — unauthenticated network bind (DEV-845)", () => {
  it.each(MCP_METHODS)("returns 401 with zero dispatch for unauthenticated POST /mcp %s", async (_label, body) => {
    const modernHandler = vi.fn();
    const legacyHandler = vi.fn();
    const toWebRequestFn = vi.fn();
    const isLegacyRequestFn = vi.fn();
    const handle = networkHandler({
      modernHandler,
      legacyHandler,
      toWebRequestFn,
      isLegacyRequestFn,
    });
    const res = mockRes();

    await handle(bodyReq(body), res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("Unauthorized");
    expect(res.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
    expect(modernHandler).not.toHaveBeenCalled();
    expect(legacyHandler).not.toHaveBeenCalled();
    expect(toWebRequestFn).not.toHaveBeenCalled();
    expect(isLegacyRequestFn).not.toHaveBeenCalled();
  });

  it("does not let a passing header predicate without a resolved identity reach tool dispatch", async () => {
    const modernHandler = vi.fn();
    const legacyHandler = vi.fn();
    const toWebRequestFn = vi.fn();
    const handle = networkHandler({
      checkAuth: (header) => header === "Bearer any-value",
      modernHandler,
      legacyHandler,
      toWebRequestFn,
    });
    const res = mockRes();

    await handle(bodyReq(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "drupal_list_nodes" } },
      { authorization: "Bearer any-value" },
    ), res);

    expect(res.statusCode).toBe(401);
    expect(modernHandler).not.toHaveBeenCalled();
    expect(legacyHandler).not.toHaveBeenCalled();
    expect(toWebRequestFn).not.toHaveBeenCalled();
  });

  it("refuses an authenticator that says ok but attaches no identity", async () => {
    const modernHandler = vi.fn();
    const legacyHandler = vi.fn();
    const handle = networkHandler({
      authenticate: async () => ({ ok: true, identity: null }),
      modernHandler,
      legacyHandler,
    });
    const res = mockRes();

    await handle(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }), res);

    expect(res.statusCode).toBe(401);
    expect(modernHandler).not.toHaveBeenCalled();
    expect(legacyHandler).not.toHaveBeenCalled();
  });
});

describe("unauthenticated route allowlist", () => {
  it("names only health and RFC 9728 metadata as open", () => {
    expect(isUnauthenticatedRoute("GET", "/health")).toBe(true);
    expect(isUnauthenticatedRoute("GET", "/health?ready=1")).toBe(true);
    expect(isUnauthenticatedRoute("GET", "/.well-known/oauth-protected-resource")).toBe(true);
    expect(isUnauthenticatedRoute("GET", "/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isUnauthenticatedRoute("POST", "/health")).toBe(false);
    expect(isUnauthenticatedRoute("GET", "/mcp")).toBe(false);
    expect(isUnauthenticatedRoute("GET", "/nope")).toBe(false);
    expect(isUnauthenticatedRoute("GET", "/debug")).toBe(false);
    expect(isUnauthenticatedRoute("GET", "/usage")).toBe(false);
  });

  it("serves /health without a token and without tool data", async () => {
    const handle = networkHandler();
    const res = mockRes();
    await handle(req("GET", "/health"), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
    expect(res.body).not.toContain("tools");
  });

  it("returns 401 without a token on every route outside the allowlist", async () => {
    const modernHandler = vi.fn();
    const legacyHandler = vi.fn();
    const handle = networkHandler({ modernHandler, legacyHandler });
    for (const [method, url] of [
      ["GET", "/nope"],
      ["GET", "/debug"],
      ["GET", "/usage"],
      ["POST", "/health"],
      ["GET", "/mcp"],
      ["DELETE", "/mcp"],
    ]) {
      const res = mockRes();
      await handle(req(method, url), res);
      expect({ method, url, status: res.statusCode }).toEqual({ method, url, status: 401 });
      expect(modernHandler).not.toHaveBeenCalled();
      expect(legacyHandler).not.toHaveBeenCalled();
    }
  });

  it("returns 404 for an authenticated unknown path", async () => {
    const handle = networkHandler({
      authenticate: async () => ({
        ok: true,
        identity: Object.freeze({ sub: "agent-1", scopes: ["mcp_read"] }),
      }),
    });
    const res = mockRes();
    await handle(req("GET", "/nope", { authorization: "Bearer good" }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe("principal filtering — unresolved vs stdio", () => {
  const defs = [
    { name: "drupal_list_sites" },
    { name: "drupal_get_node" },
    { name: "drupal_create_node" },
  ];
  const sites = [{ _name: "production", security: { preset: "development" } }];

  it("returns no tools for an unresolved principal on a network surface", async () => {
    const visible = await runWithIdentity(null, () => (
      filterToolsByPrincipal(defs, sites, null)
    ), { surface: "network" });
    expect(visible).toEqual([]);
  });

  it("keeps the full surface for stdio local operator (null identity, no network surface)", () => {
    expect(filterToolsByPrincipal(defs, sites, null).map((d) => d.name))
      .toEqual(defs.map((d) => d.name));
    expect(getRequestIdentity()).toBeNull();
  });

  it("keeps the full surface for an explicit local-operator identity", () => {
    expect(filterToolsByPrincipal(defs, sites, LOCAL_OPERATOR).map((d) => d.name))
      .toEqual(defs.map((d) => d.name));
  });
});
