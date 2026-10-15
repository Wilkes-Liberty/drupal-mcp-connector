/**
 * Failure modes (#472): a missing credential is stored as a principal; an
 * invalid, expired, revoked, wrong-audience, or issuer-down credential is
 * stored as anonymous or as a subject taken from the token; the raw token
 * or that subject appears in the row; a verified success or a post-auth
 * denial drops principal or gains actor; a loopback local operator is
 * labeled anonymous; a bearer refused before auth is labeled anonymous or
 * still reaches the authenticator.
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHttpAuditWriter } from "../../src/lib/http-audit.js";
import { createResourceAuthenticator, createRevocationStore } from "../../src/lib/http-auth.js";
import { createMcpRequestHandler } from "../../src/lib/http-handler.js";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "https://mcp.example.com/mcp";
const METADATA = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const VERIFIED_SUB = "verified-agent";
const FORGED_SUB = "forged-subject-must-not-leak";
const EXPIRED_SUB = "expired-subject-must-not-leak";
const AUDIENCE_SUB = "audience-subject-must-not-leak";
const REVOKED_SUB = "revoked-subject-must-not-leak";
const BASIC_SECRET = "basic-secret-must-not-leak";

const closers = [];
afterEach(async () => {
  while (closers.length) await closers.pop()();
});

function finishOk(_req, res) {
  if (!res.headersSent) res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
}

async function listen(handler) {
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function start(overrides = {}) {
  const writer = createHttpAuditWriter({ sink: () => {} });
  const handle = createMcpRequestHandler({
    modernHandler: finishOk,
    legacyHandler: finishOk,
    toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
    isLegacyRequestFn: async () => false,
    auditWriter: writer,
    allowedOrigins: ["https://app.example"],
    ...overrides,
  });
  return { writer, handle, listen: () => listen(handle) };
}

async function sign(privateKey, { sub, audience = AUDIENCE, exp = "5m", jti } = {}) {
  let jwt = new SignJWT({
    sub,
    scope: "mcp_read",
    azp: "verified-client",
    ...(jti ? { jti } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "actor" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt();
  if (exp !== false) jwt = jwt.setExpirationTime(exp);
  return jwt.sign(privateKey);
}

function rowFor(rows, id) {
  const matches = rows.filter((row) => row.requestId === id);
  expect(matches, id).toHaveLength(1);
  return matches[0];
}

function expectUnverified(row, ...material) {
  expect(row.actor).toBe("unverified");
  expect(row.principal).toBeUndefined();
  const json = JSON.stringify(row);
  for (const secret of material) expect(json).not.toContain(secret);
}

async function send(url, { method = "POST", path = "/mcp", token, authorization, origin, requestId } = {}) {
  const headers = {
    accept: "application/json",
    ...(requestId ? { "x-request-id": requestId } : {}),
    ...(origin ? { origin } : {}),
  };
  if (authorization) headers.authorization = authorization;
  else if (token) {
    headers.authorization = `Bearer ${token}`;
    headers.cookie = `session=${token}`;
  }
  const response = await fetch(`${url}${path}`, {
    method,
    headers: method === "GET" ? headers : { ...headers, "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  await response.text();
  return response;
}

describe("authentication audit actor classification", () => {
  it("separates anonymous, unverified, and verified identities without logging tokens", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "actor";
    jwk.alg = "RS256";
    jwk.use = "sig";
    const files = new Map([["/tmp/audit-actor-revoked.json", JSON.stringify({ jti: ["revoked-jti"] })]]);
    const store = createRevocationStore({
      filePath: "/tmp/audit-actor-revoked.json",
      readFile: (path) => files.get(path),
      stat: () => ({ mtimeMs: 1 }),
    });
    const authenticate = createResourceAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: createLocalJWKSet({ keys: [jwk] }),
      revocationStore: store,
      resourceMetadataUrl: METADATA,
      clockTolerance: 0,
    });
    const valid = await sign(privateKey, { sub: VERIFIED_SUB, jti: "valid-jti" });
    const expired = await sign(privateKey, { sub: EXPIRED_SUB, exp: 1_700_000_000, jti: "expired-jti" });
    const wrongAudience = await sign(privateKey, {
      sub: AUDIENCE_SUB,
      audience: "https://other.example.com/mcp",
      jti: "audience-jti",
    });
    const revoked = await sign(privateKey, { sub: REVOKED_SUB, jti: "revoked-jti" });
    const forged = `not-a-jwt.${Buffer.from(JSON.stringify({ sub: FORGED_SUB })).toString("base64url")}.sig`;

    const { writer, listen: up } = start({
      authenticate: (req) => authenticate(req.headers.authorization, req.headers),
    });
    const url = await up();

    const missing = await send(url, { requestId: "missing" });
    expect(missing.status).toBe(401);
    const missingRow = rowFor(writer.rows, "missing");
    expect(missingRow).toMatchObject({ code: "unauthenticated", actor: "anonymous" });
    expect(missingRow.principal).toBeUndefined();

    const health = await send(url, { method: "GET", path: "/health", requestId: "health" });
    expect(health.status).toBe(200);
    expect(rowFor(writer.rows, "health")).toMatchObject({ code: "ok", actor: "anonymous" });

    const cases = [
      ["forged", forged, FORGED_SUB],
      ["expired", expired, EXPIRED_SUB],
      ["audience", wrongAudience, AUDIENCE_SUB],
      ["revoked", revoked, REVOKED_SUB],
    ];
    for (const [id, token, subject] of cases) {
      const response = await send(url, { token, requestId: id });
      expect(response.status, id).toBe(401);
      const row = rowFor(writer.rows, id);
      expect(row.code, id).toBe("invalid_token");
      expectUnverified(row, token, subject);
    }

    const basic = await send(url, {
      authorization: `Basic ${BASIC_SECRET}`,
      requestId: "basic",
    });
    expect(basic.status).toBe(401);
    expectUnverified(rowFor(writer.rows, "basic"), BASIC_SECRET);

    const ok = await send(url, { token: valid, requestId: "ok" });
    expect(ok.status).toBe(200);
    const okRow = rowFor(writer.rows, "ok");
    expect(okRow).toMatchObject({ code: "ok", principal: VERIFIED_SUB });
    expect(okRow.actor).toBeUndefined();
    expect(JSON.stringify(okRow)).not.toContain(valid);

    const denied = await send(url, { token: valid, origin: "https://evil.example", requestId: "denied" });
    expect(denied.status).toBe(403);
    const deniedRow = rowFor(writer.rows, "denied");
    expect(deniedRow).toMatchObject({ code: "bad_origin", principal: VERIFIED_SUB });
    expect(deniedRow.actor).toBeUndefined();
    expect(JSON.stringify(deniedRow)).not.toContain(valid);
  });

  it("classifies an unreachable issuer as unverified and keeps the token out of the row", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "actor";
    jwk.alg = "RS256";
    jwk.use = "sig";
    const token = await sign(privateKey, { sub: VERIFIED_SUB });
    const authenticate = createResourceAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: createLocalJWKSet({ keys: [jwk] }),
      requireIntrospection: true,
      introspect: async () => { throw new Error("issuer down"); },
      resourceMetadataUrl: METADATA,
    });
    const { writer, listen: up } = start({
      authenticate: (req) => authenticate(req.headers.authorization, req.headers),
    });
    const url = await up();
    const response = await send(url, { token, requestId: "issuer-down" });
    expect(response.status).toBe(503);
    const row = rowFor(writer.rows, "issuer-down");
    expect(row.status).toBe(503);
    expectUnverified(row, token, VERIFIED_SUB);
  });

  it("keeps a loopback local operator unbound from anonymous and unverified", async () => {
    const { writer, listen: up } = start({
      checkAuth: () => true,
      allowLocalOperator: true,
    });
    const url = await up();
    const response = await send(url, { requestId: "local" });
    expect(response.status).toBe(200);
    const row = rowFor(writer.rows, "local");
    expect(row).toMatchObject({ code: "ok" });
    expect(row.actor).toBeUndefined();
    expect(row.principal).toBeUndefined();
  });

  it("classifies a bearer refused before verification as unverified", async () => {
    const token = "rate-limit-token-must-not-leak";
    let authenticated = false;
    const { writer, listen: up } = start({
      authenticate: async () => {
        authenticated = true;
        return { ok: true, identity: { sub: "should-not-bind" } };
      },
      rateLimiter: {
        reserve: () => ({ allowed: false, retryAfterSec: 1, commit() {}, release() {} }),
      },
    });
    const url = await up();
    const response = await send(url, { token, requestId: "limited" });
    expect(response.status).toBe(429);
    expect(authenticated).toBe(false);
    const row = rowFor(writer.rows, "limited");
    expect(row).toMatchObject({ code: "rate_limited", actor: "unverified" });
    expectUnverified(row, token);
  });
});
