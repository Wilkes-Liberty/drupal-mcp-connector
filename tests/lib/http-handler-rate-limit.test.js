/**
 * DEV-860: per-principal /mcp limiter and trusted-proxy client address.
 *
 * These assertions are red on master: standalone /mcp keys only by socket
 * address before auth, X-Forwarded-For is never read, and a second principal
 * from the same IP shares the first principal's bucket.
 */

import { describe, expect, it, vi } from "vitest";
import { createMcpRequestHandler } from "../../src/lib/http-handler.js";
import { createRateLimiter } from "../../src/lib/rate-limit.js";

function mockRes() {
  const response = {
    statusCode: null,
    headers: null,
    body: "",
    headersSent: false,
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
  return response;
}

const PING = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));

function mcpReq({
  authorization,
  remoteAddress = "203.0.113.9",
  headers = {},
} = {}) {
  return {
    method: "POST",
    url: "/mcp",
    headers: {
      host: "mcp.example",
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
      ...headers,
    },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { yield PING; },
  };
}

function handler(overrides = {}) {
  return createMcpRequestHandler({
      allowedHosts: ["mcp.example"],
    modernHandler: vi.fn(async (_req, res) => res.writeHead(200).end("tools:drupal_list_nodes")),
    legacyHandler: vi.fn(async (_req, res) => res.writeHead(200).end("legacy")),
    toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
    isLegacyRequestFn: async () => false,
    ...overrides,
  });
}

function identityFor(token) {
  if (token === "alice") {
    return {
      iss: "https://idp.example/realms/agents",
      sub: "alice",
      azp: "client-a",
      clientId: "client-a",
    };
  }
  if (token === "bob") {
    return {
      iss: "https://idp.example/realms/agents",
      sub: "bob",
      azp: "client-b",
      clientId: "client-b",
    };
  }
  return null;
}

async function authenticate(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return { ok: false, status: 401, headers: { "WWW-Authenticate": "Bearer error=\"invalid_token\"" }, body: "Unauthorized" };
  }
  const token = header.slice("Bearer ".length).trim();
  const identity = identityFor(token);
  if (!identity) {
    return { ok: false, status: 401, headers: { "WWW-Authenticate": "Bearer error=\"invalid_token\"" }, body: "Unauthorized" };
  }
  return { ok: true, identity };
}

describe("DEV-860 per-principal rate limit on /mcp", () => {
  it("429s one principal over its limit while a second principal from the same IP is unaffected", async () => {
    const h = handler({
      authenticate,
      rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 }),
      resourceMetadataUrl: "https://mcp.example/.well-known/oauth-protected-resource",
    });

    const first = mockRes();
    await h(mcpReq({ authorization: "Bearer alice" }), first);
    expect(first.statusCode).toBe(200);

    const limited = mockRes();
    await h(mcpReq({ authorization: "Bearer alice" }), limited);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["Retry-After"]).toBeTruthy();
    expect(Number(limited.headers["Retry-After"])).toBeGreaterThan(0);
    expect(limited.body).toBe("Too Many Requests");
    expect(limited.body).not.toMatch(/drupal_|tools/i);

    const other = mockRes();
    await h(mcpReq({ authorization: "Bearer bob" }), other);
    expect(other.statusCode).toBe(200);
    expect(other.body).not.toBe("Too Many Requests");
  });

  it("does not let a spoofed identity header become the principal bucket", async () => {
    const h = handler({
      authenticate,
      rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 }),
    });
    const first = mockRes();
    await h(mcpReq({
      authorization: "Bearer alice",
      headers: { "x-mcp-subject": "spoofed", "x-forwarded-user": "root" },
    }), first);
    expect(first.statusCode).toBe(200);

    const limited = mockRes();
    await h(mcpReq({
      authorization: "Bearer alice",
      headers: { "x-mcp-subject": "someone-else" },
    }), limited);
    expect(limited.statusCode).toBe(429);

    const other = mockRes();
    await h(mcpReq({ authorization: "Bearer bob" }), other);
    expect(other.statusCode).toBe(200);
  });

  it("ignores a spoofed X-Forwarded-For from an untrusted peer", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    const h = handler({
      checkAuth: () => false,
      rateLimiter: limiter,
      trustedProxies: ["10.0.0.1"],
      resourceMetadataUrl: "https://mcp.example/.well-known/oauth-protected-resource",
    });

    const first = mockRes();
    await h(mcpReq({
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "198.51.100.7" },
    }), first);
    expect(first.statusCode).toBe(401);

    const spoofed = mockRes();
    await h(mcpReq({
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "198.51.100.8" },
    }), spoofed);
    expect(spoofed.statusCode).toBe(429);
    expect(spoofed.headers["Retry-After"]).toBeTruthy();
  });

  it("uses X-Forwarded-For from a trusted proxy as the unauthenticated address key", async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    const h = handler({
      checkAuth: () => false,
      rateLimiter: limiter,
      trustedProxies: ["10.0.0.1"],
    });

    const clientA = mockRes();
    await h(mcpReq({
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.7" },
    }), clientA);
    expect(clientA.statusCode).toBe(401);

    const clientAAgain = mockRes();
    await h(mcpReq({
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.7" },
    }), clientAAgain);
    expect(clientAAgain.statusCode).toBe(429);

    const clientB = mockRes();
    await h(mcpReq({
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.8" },
    }), clientB);
    expect(clientB.statusCode).toBe(401);
  });

  it("keeps missing-token requests on the shared 401 writer when under the address limit", async () => {
    const h = handler({
      checkAuth: () => false,
      rateLimiter: createRateLimiter({ limit: 5, windowMs: 60_000, now: () => 0 }),
      resourceMetadataUrl: "https://mcp.example/.well-known/oauth-protected-resource",
    });
    const res = mockRes();
    await h(mcpReq(), res);
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("resource_metadata=");
    expect(res.body).toBe("Unauthorized");
    expect(res.body).not.toMatch(/drupal_|tools/i);
  });

  it("429s a bad-bearer flood before the next auth call once the address bucket is exhausted", async () => {
    const authenticateFn = vi.fn(authenticate);
    const h = handler({
      authenticate: authenticateFn,
      rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 }),
    });
    const first = mockRes();
    await h(mcpReq({ authorization: "Bearer bad" }), first);
    expect(first.statusCode).toBe(401);
    expect(authenticateFn).toHaveBeenCalledTimes(1);

    const limited = mockRes();
    await h(mcpReq({ authorization: "Bearer bad" }), limited);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["Retry-After"]).toBeTruthy();
    expect(authenticateFn).toHaveBeenCalledTimes(1);
    expect(limited.body).toBe("Too Many Requests");
  });
});
