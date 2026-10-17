/**
 * DEV-844: every authenticated network call is introspected at the issuer.
 *
 * In-process fake issuer (not Paladin). Each deny assertion checks that the
 * MCP handler never ran. Call `setNetworkIntrospectionGuard(false)` to
 * reproduce the red run: a live JWT is admitted without a live introspection
 * result. Environment variables cannot turn the guard off.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakeIssuer,
  FAKE_AUDIENCE,
  FAKE_ISSUER_URL,
} from "./fake-issuer.js";
import {
  createInboundHttpsAuth,
  NETWORK_INTROSPECTION_GUARD,
  NETWORK_INTROSPECTION_REQUIRED_REASON,
  networkIntrospectionRequired,
  resolveInboundAuthMode,
  resolveInboundAuthConfig,
  setNetworkIntrospectionGuard,
} from "../../src/lib/http-auth.js";
import { createMcpRequestHandler } from "../../src/lib/http-handler.js";
import {
  filterToolsByPrincipal,
  getRequestIdentity,
  isLocalOperator,
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

function bodyReq(token, body = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "drupal_list_nodes", arguments: {} },
}) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() { yield bytes; },
  };
}

async function hostedSurface(issuer, extraCfg = {}) {
  const inbound = await createInboundHttpsAuth({
    inboundCfg: {
      issuer: issuer.issuer,
      audience: issuer.audience,
      resource: issuer.audience,
      introspectionUrl: issuer.introspectionUrl,
      introspectionClientId: "rs-client",
      introspectionClientSecret: "rs-secret",
      ...extraCfg,
    },
    fetchFn: issuer.fetchFn,
  });
  const modernHandler = vi.fn(async (_req, res) => res.writeHead(200).end("dispatched"));
  const legacyHandler = vi.fn(async (_req, res) => res.writeHead(200).end("legacy"));
  const handle = createMcpRequestHandler({
    authenticate: inbound.authenticate,
    modernHandler,
    legacyHandler,
    toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
    isLegacyRequestFn: async () => false,
  });
  return { handle, modernHandler, legacyHandler, inbound };
}

function expectNoDispatch(modernHandler, legacyHandler) {
  expect(modernHandler).not.toHaveBeenCalled();
  expect(legacyHandler).not.toHaveBeenCalled();
}

describe("DEV-844 network introspection (fake issuer, not Paladin)", () => {
  afterEach(() => {
    setNetworkIntrospectionGuard(true);
  });

  it("refuses to start a network bind without issuer/introspection (fail closed)", () => {
    const decision = resolveInboundAuthMode({
      bindHost: "0.0.0.0",
      resourceServer: {
        issuer: FAKE_ISSUER_URL,
        audience: FAKE_AUDIENCE,
      },
    });
    expect(decision.mode).toBe("fatal");
    expect(decision.reason).toBe(NETWORK_INTROSPECTION_REQUIRED_REASON);
  });

  it("refuses createInboundHttpsAuth without introspection credentials", async () => {
    const issuer = await createFakeIssuer();
    await expect(createInboundHttpsAuth({
      inboundCfg: {
        issuer: issuer.issuer,
        audience: issuer.audience,
        resource: issuer.audience,
      },
      fetchFn: issuer.fetchFn,
    })).rejects.toThrow(/introspection/i);
  });

  it("(a) active token → dispatch", async () => {
    const issuer = await createFakeIssuer();
    const { handle, modernHandler, legacyHandler } = await hostedSurface(issuer);
    const token = await issuer.mint({ sub: "agent-1", scope: "mcp_read", jti: "j-active" });
    const res = mockRes();
    await handle(bodyReq(token), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("dispatched");
    expect(modernHandler).toHaveBeenCalledTimes(1);
    expect(legacyHandler).not.toHaveBeenCalled();
    expect(issuer.introspectCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("(b) revoked/inactive → 401, tool never runs", async () => {
    const issuer = await createFakeIssuer();
    const { handle, modernHandler, legacyHandler } = await hostedSurface(issuer);
    const token = await issuer.mint({ sub: "agent-1", scope: "mcp_read", jti: "j-dead" });
    issuer.revoke(token);
    const res = mockRes();
    await handle(bodyReq(token), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("Unauthorized");
    expect(res.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
    expectNoDispatch(modernHandler, legacyHandler);
  });

  it("(c) token revoked between two calls → second call 401", async () => {
    const issuer = await createFakeIssuer();
    const { handle, modernHandler, legacyHandler } = await hostedSurface(issuer);
    const token = await issuer.mint({ sub: "agent-1", scope: "mcp_read", jti: "j-mid" });

    const first = mockRes();
    await handle(bodyReq(token), first);
    expect(first.statusCode).toBe(200);
    expect(modernHandler).toHaveBeenCalledTimes(1);

    issuer.revoke(token);
    const second = mockRes();
    await handle(bodyReq(token), second);
    expect(second.statusCode).toBe(401);
    expect(modernHandler).toHaveBeenCalledTimes(1);
    expect(legacyHandler).not.toHaveBeenCalled();
    expect(issuer.introspectCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("(d) introspection down/timeout → 503, tool never runs", async () => {
    const issuer = await createFakeIssuer();
    const { handle, modernHandler, legacyHandler } = await hostedSurface(issuer, {
      introspectionTimeoutMs: 20,
    });
    const token = await issuer.mint({ sub: "agent-1", scope: "mcp_read", jti: "j-hang" });
    issuer.setMode("hang");
    const res = mockRes();
    await handle(bodyReq(token), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/unavailable|Authorization server/i);
    expectNoDispatch(modernHandler, legacyHandler);
  });

  it("(d2) introspection unreachable → 503, tool never runs", async () => {
    const issuer = await createFakeIssuer();
    const { handle, modernHandler, legacyHandler } = await hostedSurface(issuer);
    const token = await issuer.mint({ sub: "agent-1", scope: "mcp_read", jti: "j-down" });
    issuer.setMode("down");
    const res = mockRes();
    await handle(bodyReq(token), res);
    expect(res.statusCode).toBe(503);
    expectNoDispatch(modernHandler, legacyHandler);
  });

  it("(e) missing iss → 401, tool never runs", async () => {
    const issuer = await createFakeIssuer();
    const { handle, modernHandler, legacyHandler } = await hostedSurface(issuer);
    const token = await issuer.mint(
      { sub: "agent-1", scope: "mcp_read", jti: "j-no-iss" },
      { includeIss: false },
    );
    const res = mockRes();
    await handle(bodyReq(token), res);
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
    expectNoDispatch(modernHandler, legacyHandler);
  });

  it("(f) wrong iss → 401, tool never runs", async () => {
    const issuer = await createFakeIssuer();
    const { handle, modernHandler, legacyHandler } = await hostedSurface(issuer);
    const token = await issuer.mint({
      sub: "agent-1",
      scope: "mcp_read",
      jti: "j-wrong-iss",
      iss: "https://rogue-idp.test",
    });
    const res = mockRes();
    await handle(bodyReq(token), res);
    expect(res.statusCode).toBe(401);
    expectNoDispatch(modernHandler, legacyHandler);
  });

  it("(g) wrong audience → 401, tool never runs", async () => {
    const issuer = await createFakeIssuer();
    const { handle, modernHandler, legacyHandler } = await hostedSurface(issuer);
    const token = await issuer.mint({
      sub: "agent-1",
      scope: "mcp_read",
      jti: "j-wrong-aud",
      aud: "https://other.example.com/mcp",
    });
    const res = mockRes();
    await handle(bodyReq(token), res);
    expect(res.statusCode).toBe(401);
    expectNoDispatch(modernHandler, legacyHandler);
  });

  it("(h) stdio dev mode is unchanged (null identity stays local operator)", () => {
    expect(getRequestIdentity()).toBeNull();
    expect(isLocalOperator(null)).toBe(true);
    const defs = [{ name: "drupal_list_nodes" }, { name: "drupal_create_node" }];
    const sites = [{ _name: "production", security: { preset: "development" } }];
    expect(filterToolsByPrincipal(defs, sites, null).map((item) => item.name))
      .toEqual(defs.map((item) => item.name));
    expect(resolveInboundAuthMode({
      bindHost: "127.0.0.1",
      allowUnauth: false,
      sharedToken: "",
    }).mode).toBe("unauthenticated");
  });

  it("does not treat the revocation file as network authority", async () => {
    const issuer = await createFakeIssuer();
    const revocationFile = join(mkdtempSync(join(tmpdir(), "dev-844-")), "revoked.json");
    writeFileSync(revocationFile, JSON.stringify({ jti: ["j-file"] }));
    const { handle, modernHandler } = await hostedSurface(issuer, { revocationFile });
    const token = await issuer.mint({ sub: "agent-1", scope: "mcp_read", jti: "j-file" });
    const res = mockRes();
    await handle(bodyReq(token), res);
    expect(res.statusCode).toBe(200);
    expect(modernHandler).toHaveBeenCalledTimes(1);
  });

  it("resolves introspection settings from env without committing secrets", () => {
    const resolved = resolveInboundAuthConfig({
      auth: {
        issuer: FAKE_ISSUER_URL,
        audience: FAKE_AUDIENCE,
        introspectionUrl: "https://issuer.test/introspect",
        introspectionClientIdEnv: "PALADIN_INTROSPECT_ID",
        introspectionClientSecretEnv: "PALADIN_INTROSPECT_SECRET",
      },
    }, {
      PALADIN_INTROSPECT_ID: "from-named-env",
      PALADIN_INTROSPECT_SECRET: "from-named-secret",
      MCP_INTROSPECTION_TIMEOUT_MS: "1500",
    });
    expect(resolved.introspectionClientId).toBe("from-named-env");
    expect(resolved.introspectionClientSecret).toBe("from-named-secret");
    expect(resolved.introspectionTimeoutMs).toBe(1500);
    expect(resolved.issuer).toBe(FAKE_ISSUER_URL);
  });

  it("prefers MCP_INTROSPECTION_CLIENT_* over named env keys", () => {
    const resolved = resolveInboundAuthConfig({
      auth: {
        issuer: FAKE_ISSUER_URL,
        audience: FAKE_AUDIENCE,
        introspectionClientIdEnv: "NAMED_ID",
        introspectionClientSecretEnv: "NAMED_SECRET",
      },
    }, {
      NAMED_ID: "named",
      NAMED_SECRET: "named-secret",
      MCP_INTROSPECTION_CLIENT_ID: "direct-id",
      MCP_INTROSPECTION_CLIENT_SECRET: "direct-secret",
    });
    expect(resolved.introspectionClientId).toBe("direct-id");
    expect(resolved.introspectionClientSecret).toBe("direct-secret");
  });
});

describe("DEV-844 guard toggle (test-only red evidence)", () => {
  afterEach(() => {
    setNetworkIntrospectionGuard(true);
  });

  it("exposes a test-only switch that defaults to required", () => {
    expect(NETWORK_INTROSPECTION_GUARD.required).toBe(true);
    setNetworkIntrospectionGuard(false);
    expect(NETWORK_INTROSPECTION_GUARD.required).toBe(false);
    expect(resolveInboundAuthMode({
      bindHost: "0.0.0.0",
      resourceServer: { issuer: FAKE_ISSUER_URL, audience: FAKE_AUDIENCE },
    }).mode).toBe("resource_server");
  });
});

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function javascriptSources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...javascriptSources(path));
    else if (entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

describe("DEV-844 introspection guard is not an environment switch", () => {
  it("keeps the guard on when VITEST and MCP_TEST_DISABLE_INTROSPECTION_GUARD are set", async () => {
    setNetworkIntrospectionGuard(true);
    const previousVitest = process.env.VITEST;
    const previousFlag = process.env.MCP_TEST_DISABLE_INTROSPECTION_GUARD;
    process.env.VITEST = "1";
    process.env.MCP_TEST_DISABLE_INTROSPECTION_GUARD = "1";
    try {
      expect(networkIntrospectionRequired()).toBe(true);
      expect(resolveInboundAuthMode({
        bindHost: "0.0.0.0",
        resourceServer: { issuer: FAKE_ISSUER_URL, audience: FAKE_AUDIENCE },
      }).mode).toBe("fatal");
      const fetchFn = vi.fn(async () => {
        throw new Error("issuer discovery must not run");
      });
      await expect(createInboundHttpsAuth({
        inboundCfg: {
          issuer: FAKE_ISSUER_URL,
          audience: FAKE_AUDIENCE,
          resource: FAKE_AUDIENCE,
        },
        fetchFn,
      })).rejects.toThrow(/RFC 7662 introspection/);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousFlag === undefined) delete process.env.MCP_TEST_DISABLE_INTROSPECTION_GUARD;
      else process.env.MCP_TEST_DISABLE_INTROSPECTION_GUARD = previousFlag;
    }
  });

  it("does not read a bypass variable from production source", () => {
    const hits = javascriptSources(join(REPO_ROOT, "src")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return text.includes("MCP_TEST_DISABLE_INTROSPECTION_GUARD")
        || text.includes("process.env.VITEST");
    });
    // VITEST is read only by the test-only seam that gates set*Guard switches.
    expect(hits).toEqual([join(REPO_ROOT, "src/lib/test-only.js")]);
    expect(readFileSync(join(REPO_ROOT, "src/lib/test-only.js"), "utf8"))
      .not.toMatch(/MCP_TEST_DISABLE_INTROSPECTION_GUARD/);
  });
});

describe("DEV-844 stdio revocation docs", () => {
  it("says stdio has no bearer authentication or revocation path", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs/security-hardening.md"), "utf8");
    const example = readFileSync(join(REPO_ROOT, "config/config.example.json"), "utf8");
    for (const text of [doc, example]) {
      expect(text).toMatch(/stdio has no bearer authentication or revocation path/i);
      expect(text).not.toMatch(/stdio-dev/);
    }
  });
});
