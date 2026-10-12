/**
 * DEV-877: every connector-emitted 401 carries a Bearer challenge whose
 * resource_metadata URL matches the served RFC 9728 document.
 *
 * These assertions are meant to fail on the sites that still write a bare
 * 401 (shared-bearer, authenticator throw, DEV-845 unresolved identity,
 * and any future writeHead(401) that skips the shared builder). Authenticator
 * denials that already go through denyAuth should stay green.
 */

import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createResourceAuthenticator,
  formatWwwAuthenticate,
  protectedResourceMetadata,
  resourceMetadataUrlFor,
} from "../../src/lib/http-auth.js";
import { createMcpRequestHandler } from "../../src/lib/http-handler.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RESOURCE = "https://mcp.example.com/mcp";
const METADATA_URL = resourceMetadataUrlFor(RESOURCE);
const METADATA_PATH = new URL(METADATA_URL).pathname;
const METADATA_DOC = protectedResourceMetadata({
  resource: RESOURCE,
  authorizationServers: ["https://idp.example.com"],
  scopesSupported: ["mcp_read"],
});
const ISSUER = "https://idp.example.com";

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

function req(method, url, headers = {}) {
  return { method, url, headers, socket: { remoteAddress: "127.0.0.1" } };
}

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

function handler(overrides = {}) {
  return createMcpRequestHandler({
    checkAuth: () => true,
    protectedResource: METADATA_DOC,
    resourceMetadataUrl: METADATA_URL,
    modernHandler: vi.fn(async (_req, res) => res.writeHead(200).end("modern")),
    legacyHandler: vi.fn(async (_req, res) => res.writeHead(200).end("legacy")),
    toWebRequestFn: async () => new Request("http://127.0.0.1/mcp", { method: "POST" }),
    isLegacyRequestFn: async () => false,
    ...overrides,
  });
}

/**
 * Assert a 401 Bearer challenge whose resource_metadata URL is the one
 * served at /.well-known/oauth-protected-resource.
 *
 * @param {{statusCode: number, headers: object, body: string}} res
 * @param {{error?: string, errorDescription?: string}} [expected]
 */
function expectRfc9728Challenge(res, {
  error = "invalid_token",
  errorDescription,
} = {}) {
  expect(res.statusCode).toBe(401);
  const challenge = res.headers?.["WWW-Authenticate"] ?? res.headers?.["www-authenticate"];
  expect(challenge, "WWW-Authenticate present").toEqual(expect.any(String));
  expect(challenge).toMatch(/^Bearer\b/);
  expect(challenge).toContain(`error="${error}"`);
  if (errorDescription) {
    expect(challenge).toContain(`error_description="${errorDescription}"`);
  }
  expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
  expect(METADATA_URL).toContain("/.well-known/oauth-protected-resource");
}

async function expectServedMetadata(handle) {
  const res = mockRes();
  await handle(req("GET", METADATA_PATH), res);
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual(METADATA_DOC);
  expect(METADATA_PATH).toBe("/.well-known/oauth-protected-resource/mcp");
}

async function signedToken({ privateKey, claims = {}, issuer = ISSUER, audience = RESOURCE, exp = "5m" }) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(exp)
    .setSubject(claims.sub ?? "agent-1")
    .sign(privateKey);
}

async function authenticatorFixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const authenticate = createResourceAuthenticator({
    issuer: ISSUER,
    audience: RESOURCE,
    jwks: createLocalJWKSet({ keys: [jwk] }),
    resourceMetadataUrl: METADATA_URL,
    clockTolerance: 0,
  });
  return {
    privateKey,
    authenticate: (incoming) => authenticate(incoming.headers.authorization, incoming.headers),
  };
}

function walkJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walkJs(full) : entry.name.endsWith(".js") ? [full] : [];
  });
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function writeUnauthorizedSpan(src) {
  const start = src.indexOf("export function writeUnauthorized");
  if (start < 0) return null;
  const next = src.indexOf("\nexport ", start + 1);
  return { start, end: next < 0 ? src.length : next };
}

describe("DEV-877: 401 challenge matches served RFC 9728 metadata", () => {
  it("serves the well-known document at the resource_metadata path", async () => {
    await expectServedMetadata(handler());
  });

  it("missing token (resource-server authenticator) includes resource_metadata", async () => {
    const { authenticate } = await authenticatorFixture();
    const handle = handler({ authenticate });
    const res = mockRes();
    await handle(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }), res);
    expectRfc9728Challenge(res, { errorDescription: "Bearer token required" });
  });

  it("invalid token includes resource_metadata", async () => {
    const { authenticate } = await authenticatorFixture();
    const handle = handler({ authenticate });
    const res = mockRes();
    await handle(req("POST", "/mcp", { authorization: "Bearer not-a-jwt" }), res);
    expectRfc9728Challenge(res, { errorDescription: "Token validation failed" });
  });

  it("expired token includes resource_metadata", async () => {
    const { authenticate, privateKey } = await authenticatorFixture();
    const token = await new SignJWT({ sub: "agent-1" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime(1_700_000_000)
      .sign(privateKey);
    const handle = handler({ authenticate });
    const res = mockRes();
    await handle(req("POST", "/mcp", { authorization: `Bearer ${token}` }), res);
    expectRfc9728Challenge(res);
  });

  it("wrong audience includes resource_metadata", async () => {
    const { authenticate, privateKey } = await authenticatorFixture();
    const token = await signedToken({
      privateKey,
      audience: "https://other.example.com/mcp",
    });
    const handle = handler({ authenticate });
    const res = mockRes();
    await handle(req("POST", "/mcp", { authorization: `Bearer ${token}` }), res);
    expectRfc9728Challenge(res);
  });

  it("authenticator throw on /mcp includes resource_metadata", async () => {
    const handle = handler({
      authenticate: async () => { throw new Error("corrupt revocation"); },
    });
    const res = mockRes();
    await handle(req("POST", "/mcp", { authorization: "Bearer x" }), res);
    expectRfc9728Challenge(res, { errorDescription: "Token validation failed" });
  });

  it("shared-bearer refusal includes resource_metadata", async () => {
    const handle = handler({
      checkAuth: () => false,
      authenticate: null,
    });
    const res = mockRes();
    await handle(req("POST", "/mcp", { authorization: "Bearer nope" }), res);
    expectRfc9728Challenge(res, { errorDescription: "Bearer token required" });
  });

  it("DEV-845 unresolved identity (no allowLocalOperator) includes resource_metadata", async () => {
    const handle = handler({
      checkAuth: () => true,
      allowLocalOperator: false,
      authenticate: null,
    });
    const res = mockRes();
    await handle(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }), res);
    expectRfc9728Challenge(res, { errorDescription: "Bearer token required" });
  });

  it("DEV-845 authenticator ok without identity includes resource_metadata", async () => {
    const handle = handler({
      authenticate: async () => ({ ok: true, identity: null }),
    });
    const res = mockRes();
    await handle(bodyReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }), res);
    expectRfc9728Challenge(res, { errorDescription: "Bearer token required" });
  });

  it("unknown path without identity is 401 with the same challenge", async () => {
    const handle = handler({
      checkAuth: () => true,
      allowLocalOperator: false,
    });
    const res = mockRes();
    await handle(req("GET", "/nope"), res);
    expectRfc9728Challenge(res, { errorDescription: "Bearer token required" });
  });
});

describe("DEV-877: shared 401 builder is the only writer", () => {
  it("exports writeUnauthorized and unauthorizedChallenge", async () => {
    const auth = await import("../../src/lib/http-auth.js");
    expect(typeof auth.unauthorizedChallenge).toBe("function");
    expect(typeof auth.writeUnauthorized).toBe("function");
    const headers = auth.unauthorizedChallenge({
      error: "invalid_token",
      errorDescription: "Bearer token required",
      resourceMetadata: METADATA_URL,
    });
    expect(headers["WWW-Authenticate"]).toBe(formatWwwAuthenticate({
      error: "invalid_token",
      errorDescription: "Bearer token required",
      resourceMetadata: METADATA_URL,
    }));
    const res = mockRes();
    auth.writeUnauthorized(res, {
      error: "invalid_token",
      errorDescription: "Bearer token required",
      resourceMetadata: METADATA_URL,
    });
    expectRfc9728Challenge(res, { errorDescription: "Bearer token required" });
    expect(res.body).toBe("Unauthorized");
  });

  it("fails if any src path writes 401 without writeUnauthorized", () => {
    const offenders = [];
    for (const file of walkJs(join(ROOT, "src"))) {
      const rel = file.slice(ROOT.length + 1);
      const text = readFileSync(file, "utf8");
      const span = rel === "src/lib/http-auth.js" ? writeUnauthorizedSpan(text) : null;
      for (const match of text.matchAll(/writeHead\(\s*401/g)) {
        const line = text.split("\n")[lineOf(text, match.index) - 1] ?? "";
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        const allowed = span && match.index >= span.start && match.index < span.end;
        if (!allowed) {
          offenders.push(`${rel}:${lineOf(text, match.index)}`);
        }
      }
      if (rel !== "src/lib/http-auth.js" && /formatWwwAuthenticate\(/.test(text)) {
        offenders.push(`${rel}: formatWwwAuthenticate used outside the shared builder`);
      }
    }
    expect(offenders, "401 sites that skip writeUnauthorized").toEqual([]);
  });
});
