import { describe, it, expect, vi } from "vitest";
import { generateKeyPair, exportJWK, exportSPKI, SignJWT, createLocalJWKSet } from "jose";
import {
  makeBearerCheck,
  parseBearerToken,
  scopesFromClaim,
  buildIdentity,
  identityHasScopes,
  formatWwwAuthenticate,
  protectedResourceMetadata,
  resourceMetadataUrlFor,
  createRevocationStore,
  createResourceAuthenticator,
  createInboundHttpsAuth,
  validateBearerTimeClaims,
  compactJwtAlgorithmRefusal,
  authorizationServerDiscoveryUrls,
  discoverAuthorizationServer,
  introspectToken,
  resolveInboundAuthMode,
  inboundAuthDeprecationWarning,
  resolveInboundAuthConfig,
  INBOUND_IDP_TIMEOUT_MS,
} from "../../src/lib/http-auth.js";
import { authHeaders, authHeadersAsync } from "../../src/lib/config.js";

describe("makeBearerCheck", () => {
  it("disabled (no token) accepts anything", () => {
    const ok = makeBearerCheck("");
    expect(ok(undefined)).toBe(true);
    expect(ok("Bearer whatever")).toBe(true);
  });
  it("accepts the matching bearer token", () => {
    const ok = makeBearerCheck("s3cret");
    expect(ok("Bearer s3cret")).toBe(true);
  });
  it("rejects a wrong / missing / malformed token", () => {
    const ok = makeBearerCheck("s3cret");
    expect(ok("Bearer nope")).toBe(false);
    expect(ok("s3cret")).toBe(false);
    expect(ok(undefined)).toBe(false);
    expect(ok("Bearer s3cre")).toBe(false);
  });
});

describe("parseBearerToken / scopes / identity", () => {
  it("parses a Bearer token and rejects other schemes", () => {
    expect(parseBearerToken("Bearer abc")).toBe("abc");
    expect(parseBearerToken("Basic abc")).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
  });

  it("splits space- or comma-delimited scopes", () => {
    expect(scopesFromClaim("mcp_read mcp_write")).toEqual(["mcp_read", "mcp_write"]);
    expect(scopesFromClaim(["mcp_read", "mcp_config"])).toEqual(["mcp_read", "mcp_config"]);
    expect(scopesFromClaim(undefined)).toEqual([]);
  });

  it("freezes identity from claims and ignores missing fields", () => {
    const identity = buildIdentity({
      sub: "agent-1",
      iss: "https://idp.example.com",
      aud: "https://mcp.example.com/mcp",
      scope: "mcp_read mcp_write",
      exp: 1_800_000_000,
      jti: "j1",
      azp: "content-agent",
    });
    expect(identity.sub).toBe("agent-1");
    expect(identity.scopes).toEqual(["mcp_read", "mcp_write"]);
    expect(identity.clientId).toBe("content-agent");
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.scopes)).toBe(true);
    expect(identityHasScopes(identity, ["mcp_read"])).toBe(true);
    expect(identityHasScopes(identity, ["mcp_admin"])).toBe(false);
    expect(identity.sites).toBeNull();
    expect(identity.actSub).toBeNull();
  });

  it("captures JWT act.sub as a delegator hint and ignores a missing act", () => {
    expect(buildIdentity({ act: { sub: "operator-1" } }).actSub).toBe("operator-1");
    expect(buildIdentity({ act: "operator-1" }).actSub).toBeNull();
  });

  it("captures a server-issued sites claim and ignores a missing one", () => {
    expect(buildIdentity({ sites: ["production", "staging"] }).sites)
      .toEqual(["production", "staging"]);
    expect(buildIdentity({ mcp_sites: "staging" }).sites).toEqual(["staging"]);
    expect(buildIdentity({}).sites).toBeNull();
  });
});

describe("WWW-Authenticate and protected-resource metadata", () => {
  it("formats an invalid_token challenge with a resource_metadata URL", () => {
    expect(formatWwwAuthenticate({
      error: "invalid_token",
      errorDescription: "expired",
      resourceMetadata: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    })).toBe(
      "Bearer realm=\"mcp\", error=\"invalid_token\", error_description=\"expired\", " +
      "resource_metadata=\"https://mcp.example.com/.well-known/oauth-protected-resource/mcp\"",
    );
  });

  it("formats an insufficient_scope challenge", () => {
    expect(formatWwwAuthenticate({
      error: "insufficient_scope",
      scope: "mcp_read",
    })).toContain("error=\"insufficient_scope\"");
    expect(formatWwwAuthenticate({
      error: "insufficient_scope",
      scope: "mcp_read",
    })).toContain("scope=\"mcp_read\"");
  });

  it("builds RFC 9728 metadata and the path-qualified well-known URL", () => {
    const resource = "https://mcp.example.com/mcp";
    expect(resourceMetadataUrlFor(resource)).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(protectedResourceMetadata({
      resource,
      authorizationServers: ["https://idp.example.com"],
      scopesSupported: ["mcp_read"],
    })).toEqual({
      resource,
      authorization_servers: ["https://idp.example.com"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp_read"],
    });
  });
});

describe("resolveInboundAuthMode", () => {
  const rs = { issuer: "https://idp.example.com", audience: "https://mcp.example.com/mcp" };

  it("requires a resource server on a network-facing bind", () => {
    expect(resolveInboundAuthMode({
      bindHost: "0.0.0.0",
      sharedToken: "legacy-secret",
    }).mode).toBe("fatal");
  });

  it("accepts the resource server on a network-facing bind and ignores a shared token", () => {
    expect(resolveInboundAuthMode({
      bindHost: "0.0.0.0",
      sharedToken: "legacy-secret",
      resourceServer: rs,
    }).mode).toBe("resource_server");
  });

  it("keeps MCP_AUTH_TOKEN on loopback", () => {
    expect(resolveInboundAuthMode({
      bindHost: "127.0.0.1",
      sharedToken: "legacy-secret",
    }).mode).toBe("shared_bearer");
  });

  it("is fatal for allow-unauthenticated on a non-loopback bind (DEV-845)", () => {
    const decision = resolveInboundAuthMode({
      bindHost: "0.0.0.0",
      allowUnauth: true,
    });
    expect(decision.mode).toBe("fatal");
    expect(decision.reason).toMatch(/non-loopback bind with MCP_ALLOW_UNAUTHENTICATED is not permitted/);
  });

  it("still allows explicit unauthenticated loopback", () => {
    expect(resolveInboundAuthMode({
      bindHost: "127.0.0.1",
      allowUnauth: true,
    }).mode).toBe("unauthenticated");
  });
});

describe("inboundAuthDeprecationWarning", () => {
  it("warns for shared_bearer and names the removal major", () => {
    const warning = inboundAuthDeprecationWarning("shared_bearer");
    expect(warning).toEqual(expect.stringContaining("WARNING"));
    expect(warning).toEqual(expect.stringContaining("shared_bearer"));
    expect(warning).toEqual(expect.stringContaining("v4.0.0"));
    expect(warning).toEqual(expect.stringContaining("#231"));
  });

  it("is silent in resource-server mode", () => {
    expect(inboundAuthDeprecationWarning("resource_server")).toBeNull();
  });

  it("is silent for unauthenticated and fatal modes", () => {
    expect(inboundAuthDeprecationWarning("unauthenticated")).toBeNull();
    expect(inboundAuthDeprecationWarning("fatal")).toBeNull();
  });
});

describe("resolveInboundAuthConfig", () => {
  it("prefers environment overrides over config.auth", () => {
    const resolved = resolveInboundAuthConfig(
      { auth: { issuer: "https://idp.example.com", audience: "https://mcp.example.com/mcp" } },
      { MCP_RESOURCE_ISSUER: "https://other.example.com" },
    );
    expect(resolved.issuer).toBe("https://other.example.com");
    expect(resolved.audience).toBe("https://mcp.example.com/mcp");
    expect(resolved.resource).toBe("https://mcp.example.com/mcp");
  });

  it("defaults maxTokenLifetime and algorithms, and prefers env overrides", () => {
    const defaults = resolveInboundAuthConfig({
      auth: { issuer: "https://idp.example.com", audience: "https://mcp.example.com/mcp" },
    }, {});
    expect(defaults.maxTokenLifetime).toBe(3600);
    expect(defaults.algorithms).toEqual([
      "RS256", "RS384", "RS512",
      "ES256", "ES384", "ES512",
      "PS256", "PS384", "PS512",
      "EdDSA",
    ]);

    const overridden = resolveInboundAuthConfig(
      {
        auth: {
          issuer: "https://idp.example.com",
          audience: "https://mcp.example.com/mcp",
          maxTokenLifetime: 900,
          algorithms: ["ES256"],
        },
      },
      { MCP_MAX_TOKEN_LIFETIME: "1800", MCP_TOKEN_ALGORITHMS: "RS256,PS256" },
    );
    expect(overridden.maxTokenLifetime).toBe(1800);
    expect(overridden.algorithms).toEqual(["RS256", "PS256"]);
  });
});

async function signedToken({
  privateKey,
  kid = "test",
  claims = {},
  issuer,
  audience,
  exp = "5m",
  iat,
  alg = "RS256",
  key = privateKey,
} = {}) {
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg, kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(claims.sub ?? "agent-1");
  if (iat !== false) jwt = jwt.setIssuedAt(iat);
  if (exp !== false) jwt = jwt.setExpirationTime(exp);
  return jwt.sign(key);
}

function compactJwt(header, payload, signature = "") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode(header)}.${encode(payload)}.${signature}`;
}

describe("createResourceAuthenticator", () => {
  const issuer = "https://idp.example.com";
  const audience = "https://mcp.example.com/mcp";
  const metadata = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";

  async function fixture() {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test";
    jwk.alg = "RS256";
    jwk.use = "sig";
    const jwks = createLocalJWKSet({ keys: [jwk] });
    return { publicKey, privateKey, jwks };
  }

  it("accepts a valid JWT and returns a frozen identity", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await signedToken({
      privateKey,
      issuer,
      audience,
      claims: { sub: "agent-1", scope: "mcp_read mcp_write", jti: "j1" },
    });
    const authenticate = createResourceAuthenticator({
      issuer, audience, jwks, resourceMetadataUrl: metadata,
    });
    const result = await authenticate(`Bearer ${token}`);
    expect(result.ok).toBe(true);
    expect(result.identity.sub).toBe("agent-1");
    expect(result.identity.scopes).toEqual(["mcp_read", "mcp_write"]);
    expect(Object.isFrozen(result.identity)).toBe(true);
  });

  it("accepts a token when the configured issuer only differs by a trailing slash", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await signedToken({
      privateKey, issuer, audience, claims: { sub: "agent-1", scope: "mcp_read" },
    });
    const authenticate = createResourceAuthenticator({
      issuer: `${issuer}/`, audience, jwks, resourceMetadataUrl: metadata,
    });
    expect((await authenticate(`Bearer ${token}`)).ok).toBe(true);
  });

  it("rejects the wrong issuer, audience, and an expired token", async () => {
    const { privateKey, jwks } = await fixture();
    const authenticate = createResourceAuthenticator({
      issuer, audience, jwks, resourceMetadataUrl: metadata, clockTolerance: 0,
    });

    const wrongIss = await signedToken({
      privateKey, issuer: "https://evil.example.com", audience, claims: { sub: "agent-1" },
    });
    const wrongAud = await signedToken({
      privateKey, issuer, audience: "https://other.example.com/mcp", claims: { sub: "agent-1" },
    });
    const expired = await new SignJWT({ sub: "agent-1" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(1_700_000_000)
      .sign(privateKey);

    for (const token of [wrongIss, wrongAud, expired]) {
      const result = await authenticate(`Bearer ${token}`);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(401);
      expect(result.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
      expect(result.headers["WWW-Authenticate"]).toContain("resource_metadata=");
    }
  });

  it("returns insufficient_scope when a required scope is missing", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await signedToken({
      privateKey, issuer, audience, claims: { sub: "agent-1", scope: "mcp_read" },
    });
    const authenticate = createResourceAuthenticator({
      issuer, audience, jwks, requiredScopes: ["mcp_admin"], resourceMetadataUrl: metadata,
    });
    const result = await authenticate(`Bearer ${token}`);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.headers["WWW-Authenticate"]).toContain("error=\"insufficient_scope\"");
    expect(result.headers["WWW-Authenticate"]).toContain("scope=\"mcp_admin\"");
  });

  it("does not take identity from caller-supplied headers (replayed context)", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await signedToken({
      privateKey, issuer, audience, claims: { sub: "agent-1", scope: "mcp_read" },
    });
    const authenticate = createResourceAuthenticator({
      issuer, audience, jwks, resourceMetadataUrl: metadata,
    });
    const result = await authenticate(`Bearer ${token}`, {
      "x-mcp-subject": "admin",
      "x-mcp-actor": "break-glass",
      "x-forwarded-user": "root",
    });
    expect(result.ok).toBe(true);
    expect(result.identity.sub).toBe("agent-1");
    expect(result.identity.sub).not.toBe("admin");
  });

  it("refuses a revoked jti without a process restart", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await signedToken({
      privateKey, issuer, audience, claims: { sub: "agent-1", jti: "revoked-1", scope: "mcp_read" },
    });
    const files = new Map();
    const mtimes = new Map();
    const store = createRevocationStore({
      filePath: "/tmp/revoked.json",
      readFile: (path) => files.get(path),
      stat: (path) => {
        if (!mtimes.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { mtimeMs: mtimes.get(path) };
      },
    });
    const authenticate = createResourceAuthenticator({
      issuer, audience, jwks, revocationStore: store, resourceMetadataUrl: metadata,
    });

    expect((await authenticate(`Bearer ${token}`)).ok).toBe(true);

    files.set("/tmp/revoked.json", JSON.stringify({ jti: ["revoked-1"] }));
    mtimes.set("/tmp/revoked.json", 2);
    const denied = await authenticate(`Bearer ${token}`);
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
    expect(denied.headers["WWW-Authenticate"]).toContain("revoked");
  });

  it("revokes a jti immediately without waiting for mtime", () => {
    const files = new Map([["/tmp/revoked.json", JSON.stringify({ jti: [] })]]);
    const store = createRevocationStore({
      filePath: "/tmp/revoked.json",
      readFile: (path) => files.get(path),
      writeFile: (path, body) => { files.set(path, body); },
      stat: () => ({ mtimeMs: 1 }),
    });
    expect(store.isRevoked({ jti: "gone-1" })).toBe(false);
    expect(store.revoke({ jti: "gone-1" })).toEqual({ ok: true });
    expect(store.isRevoked({ jti: "gone-1" })).toBe(true);
    expect(JSON.parse(files.get("/tmp/revoked.json")).jti).toContain("gone-1");
  });

  it("refuses to overwrite a corrupt revocation file", () => {
    const files = new Map([["/tmp/revoked.json", "{not-json"]]);
    const store = createRevocationStore({
      filePath: "/tmp/revoked.json",
      readFile: (path) => files.get(path),
      writeFile: (path, body) => { files.set(path, body); },
      stat: () => ({ mtimeMs: 1 }),
    });
    expect(store.revoke({ jti: "gone-1" })).toEqual({ ok: false, reason: "unreadable" });
    expect(files.get("/tmp/revoked.json")).toBe("{not-json");
  });

  it("creates the revocation file when none exists", () => {
    const files = new Map();
    const store = createRevocationStore({
      filePath: "/tmp/revoked.json",
      readFile: (path) => {
        if (!files.has(path)) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return files.get(path);
      },
      writeFile: (path, body) => { files.set(path, body); },
      stat: (path) => {
        if (!files.has(path)) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return { mtimeMs: 1 };
      },
    });
    expect(store.revoke({ jti: "gone-1" })).toEqual({ ok: true });
    expect(JSON.parse(files.get("/tmp/revoked.json")).jti).toEqual(["gone-1"]);
  });

  it("fails closed when stat cannot read the revocation path", () => {
    const files = new Map([["/tmp/revoked.json", JSON.stringify({ jti: ["kept"] })]]);
    const store = createRevocationStore({
      filePath: "/tmp/revoked.json",
      readFile: (path) => files.get(path),
      writeFile: (path, body) => { files.set(path, body); },
      stat: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    expect(store.revoke({ jti: "gone-1" })).toEqual({ ok: false, reason: "unreadable" });
    expect(JSON.parse(files.get("/tmp/revoked.json")).jti).toEqual(["kept"]);
  });

  it("fails closed when the revocation file is corrupt", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await signedToken({
      privateKey, issuer, audience, claims: { sub: "agent-1", jti: "ok-1", scope: "mcp_read" },
    });
    const store = createRevocationStore({
      filePath: "/tmp/revoked.json",
      readFile: () => "{not-json",
      stat: () => ({ mtimeMs: 3 }),
    });
    const authenticate = createResourceAuthenticator({
      issuer, audience, jwks, revocationStore: store, resourceMetadataUrl: metadata,
    });
    const denied = await authenticate(`Bearer ${token}`);
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
  });

  it("uses introspection for an opaque token and when the AS says inactive", async () => {
    const now = Math.floor(Date.now() / 1000);
    const authenticateOpaque = createResourceAuthenticator({
      issuer,
      audience,
      verifyJwt: async () => { throw new Error("not a jwt"); },
      introspect: async (token) => token === "opaque-ok"
        ? {
          active: true,
          sub: "agent-9",
          iss: issuer,
          aud: audience,
          scope: "mcp_read",
          iat: now,
          exp: now + 300,
        }
        : null,
      resourceMetadataUrl: metadata,
    });
    const ok = await authenticateOpaque("Bearer opaque-ok");
    expect(ok.ok).toBe(true);
    expect(ok.identity.sub).toBe("agent-9");

    const dead = await authenticateOpaque("Bearer opaque-dead");
    expect(dead.ok).toBe(false);
    expect(dead.status).toBe(401);
  });

  it("returns 401 when introspection throws", async () => {
    const authenticate = createResourceAuthenticator({
      issuer,
      audience,
      verifyJwt: async () => { throw new Error("not a jwt"); },
      introspect: async () => { throw new Error("idp down"); },
      resourceMetadataUrl: metadata,
    });
    const denied = await authenticate("Bearer opaque-ok");
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
  });

  it("rejects a validly signed JWT that omits exp (DEV-876)", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await signedToken({
      privateKey, issuer, audience, claims: { sub: "agent-1", scope: "mcp_read" }, exp: false,
    });
    const authenticate = createResourceAuthenticator({
      issuer, audience, jwks, resourceMetadataUrl: metadata,
    });
    const denied = await authenticate(`Bearer ${token}`);
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
    expect(denied.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
  });

  it("rejects a JWT whose exp minus iat exceeds the lifetime cap (DEV-876)", async () => {
    const { privateKey, jwks } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    const token = await signedToken({
      privateKey,
      issuer,
      audience,
      claims: { sub: "agent-1", scope: "mcp_read" },
      iat: now,
      exp: now + 3600 + 60,
    });
    const authenticate = createResourceAuthenticator({
      issuer, audience, jwks, resourceMetadataUrl: metadata, clockTolerance: 0,
    });
    const denied = await authenticate(`Bearer ${token}`);
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
    expect(denied.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
  });

  it("accepts a JWT whose lifetime is at the documented cap (DEV-876)", async () => {
    const { privateKey, jwks } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    const token = await signedToken({
      privateKey,
      issuer,
      audience,
      claims: { sub: "agent-1", scope: "mcp_read" },
      iat: now,
      exp: now + 3600,
    });
    const authenticate = createResourceAuthenticator({
      issuer, audience, jwks, resourceMetadataUrl: metadata, clockTolerance: 0,
    });
    expect((await authenticate(`Bearer ${token}`)).ok).toBe(true);
  });

  it("refuses alg none and HS256 signed with the RSA public key (DEV-876)", async () => {
    const { publicKey, jwks } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: "agent-1",
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + 300,
      scope: "mcp_read",
    };
    const authenticate = createResourceAuthenticator({
      issuer, audience, jwks, resourceMetadataUrl: metadata,
    });

    const noneToken = compactJwt({ alg: "none", typ: "JWT" }, claims);
    const noneDenied = await authenticate(`Bearer ${noneToken}`);
    expect(noneDenied.ok).toBe(false);
    expect(noneDenied.status).toBe(401);
    expect(noneDenied.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");

    const hmacSecret = new TextEncoder().encode(await exportSPKI(publicKey));
    const hs256 = await signedToken({
      privateKey: hmacSecret,
      key: hmacSecret,
      alg: "HS256",
      issuer,
      audience,
      claims: { sub: "agent-1", scope: "mcp_read" },
    });
    const hsDenied = await authenticate(`Bearer ${hs256}`);
    expect(hsDenied.ok).toBe(false);
    expect(hsDenied.status).toBe(401);
    expect(hsDenied.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
  });

  it("does not fall back to introspection for a compact JWT whose algorithm is not allowed (DEV-876)", async () => {
    const { publicKey, jwks } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: "agent-1", iss: issuer, aud: audience, iat: now, exp: now + 300, scope: "mcp_read",
    };
    const introspected = [];
    const authenticate = createResourceAuthenticator({
      issuer,
      audience,
      jwks,
      resourceMetadataUrl: metadata,
      introspect: async (token) => {
        introspected.push(token);
        return { active: true, ...claims };
      },
    });

    const hmacSecret = new TextEncoder().encode(await exportSPKI(publicKey));
    const hs256 = await signedToken({
      privateKey: hmacSecret, key: hmacSecret, alg: "HS256", issuer, audience, claims,
    });
    const hsDenied = await authenticate(`Bearer ${hs256}`);
    expect(hsDenied.ok).toBe(false);
    expect(hsDenied.status).toBe(401);
    expect(hsDenied.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");

    const noneToken = compactJwt({ alg: "none", typ: "JWT" }, claims);
    const noneDenied = await authenticate(`Bearer ${noneToken}`);
    expect(noneDenied.ok).toBe(false);
    expect(noneDenied.status).toBe(401);

    expect(introspected).toEqual([]);

    // A token that is not a decodable JWS is still an opaque token.
    const opaque = await authenticate("Bearer not.a.jws");
    expect(opaque.ok).toBe(true);
    expect(introspected).toEqual(["not.a.jws"]);
  });

  it("compactJwtAlgorithmRefusal only refuses a decodable JWS with a disallowed alg", () => {
    const allowed = ["RS256"];
    expect(compactJwtAlgorithmRefusal(compactJwt({ alg: "HS256" }, {}), allowed)).toMatch(/not allowed/);
    expect(compactJwtAlgorithmRefusal(compactJwt({ alg: "none" }, {}), allowed)).toMatch(/not allowed/);
    expect(compactJwtAlgorithmRefusal(compactJwt({ typ: "JWT" }, {}), allowed)).toMatch(/not allowed/);
    expect(compactJwtAlgorithmRefusal(compactJwt({ alg: "RS256" }, {}), allowed)).toBeNull();
    expect(compactJwtAlgorithmRefusal("opaque-token", allowed)).toBeNull();
    expect(compactJwtAlgorithmRefusal("not.a.jws", allowed)).toBeNull();
    expect(compactJwtAlgorithmRefusal("a.b.c.d.e", allowed)).toBeNull();
  });

  it("refuses introspection active:true when exp is missing or already past (DEV-876)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const authenticate = createResourceAuthenticator({
      issuer,
      audience,
      verifyJwt: async () => { throw new Error("not a jwt"); },
      introspect: async (token) => {
        if (token === "no-exp") {
          return { active: true, sub: "agent-9", iss: issuer, aud: audience, iat: now, scope: "mcp_read" };
        }
        if (token === "expired") {
          return {
            active: true,
            sub: "agent-9",
            iss: issuer,
            aud: audience,
            iat: now - 120,
            exp: now - 60,
            scope: "mcp_read",
          };
        }
        return null;
      },
      resourceMetadataUrl: metadata,
      clockTolerance: 0,
    });

    for (const token of ["no-exp", "expired"]) {
      const denied = await authenticate(`Bearer ${token}`);
      expect(denied.ok).toBe(false);
      expect(denied.status).toBe(401);
      expect(denied.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
    }
  });

  it("refuses introspection active:true when iss is missing (DEV-876)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const authenticate = createResourceAuthenticator({
      issuer,
      audience,
      verifyJwt: async () => { throw new Error("not a jwt"); },
      introspect: async () => ({
        active: true,
        sub: "agent-9",
        aud: audience,
        iat: now,
        exp: now + 300,
        scope: "mcp_read",
      }),
      resourceMetadataUrl: metadata,
    });
    const denied = await authenticate("Bearer opaque-ok");
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
    expect(denied.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
  });

  it("refuses introspection whose exp minus iat exceeds the lifetime cap (DEV-876)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const authenticate = createResourceAuthenticator({
      issuer,
      audience,
      verifyJwt: async () => { throw new Error("not a jwt"); },
      introspect: async () => ({
        active: true,
        sub: "agent-9",
        iss: issuer,
        aud: audience,
        iat: now,
        exp: now + 3600 + 60,
        scope: "mcp_read",
      }),
      resourceMetadataUrl: metadata,
      clockTolerance: 0,
    });
    const denied = await authenticate("Bearer opaque-ok");
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
    expect(denied.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
  });

  it("refuses introspection whose iat is in the future even when exp minus iat is within the cap (DEV-876)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const authenticate = createResourceAuthenticator({
      issuer,
      audience,
      verifyJwt: async () => { throw new Error("not a jwt"); },
      introspect: async () => ({
        active: true,
        sub: "agent-9",
        iss: issuer,
        aud: audience,
        iat: now + 3600,
        exp: now + 7200,
        scope: "mcp_read",
      }),
      resourceMetadataUrl: metadata,
      clockTolerance: 0,
    });
    const denied = await authenticate("Bearer opaque-ok");
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
    expect(denied.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
  });
});

describe("validateBearerTimeClaims", () => {
  const now = 1_800_000_000;

  it("treats exp as an exclusive boundary, matching jose (DEV-876)", () => {
    expect(validateBearerTimeClaims(
      { iat: now - 300, exp: now },
      { now, clockTolerance: 0 },
    )).toEqual({ ok: false, reason: "Token has expired" });
    expect(validateBearerTimeClaims(
      { iat: now - 300, exp: now - 5 },
      { now, clockTolerance: 5 },
    )).toEqual({ ok: false, reason: "Token has expired" });
    expect(validateBearerTimeClaims(
      { iat: now - 300, exp: now + 1 },
      { now, clockTolerance: 0 },
    )).toEqual({ ok: true });
  });

  it("refuses a future iat even when exp minus iat is within the cap", () => {
    expect(validateBearerTimeClaims(
      { iat: now + 3600, exp: now + 7200 },
      { now, maxTokenLifetime: 3600, clockTolerance: 0 },
    )).toEqual({ ok: false, reason: "Token iat is in the future" });
  });

  it("accepts a slightly future iat within clockTolerance", () => {
    expect(validateBearerTimeClaims(
      { iat: now + 3, exp: now + 303 },
      { now, clockTolerance: 5 },
    )).toEqual({ ok: true });
  });
});

describe("discoverAuthorizationServer / introspectToken", () => {
  it("inserts RFC 8414 well-known between host and path", () => {
    expect(authorizationServerDiscoveryUrls("https://idp.example.com/realms/prod")).toEqual([
      "https://idp.example.com/.well-known/oauth-authorization-server/realms/prod",
      "https://idp.example.com/realms/prod/.well-known/openid-configuration",
    ]);
  });

  it("prefers RFC 8414 metadata and falls back to OIDC", async () => {
    const calls = [];
    const fetchFn = async (url) => {
      calls.push(url);
      if (url.endsWith("/openid-configuration")) {
        return {
          ok: true,
          json: async () => ({
            issuer: "https://idp.example.com",
            jwks_uri: "https://idp.example.com/jwks",
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    };
    const meta = await discoverAuthorizationServer("https://idp.example.com", fetchFn);
    expect(calls[0]).toBe("https://idp.example.com/.well-known/oauth-authorization-server");
    expect(meta.jwks_uri).toBe("https://idp.example.com/jwks");
  });

  it("rejects metadata whose issuer does not match the queried identifier", async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        issuer: "https://attacker.example",
        jwks_uri: "https://attacker.example/jwks",
      }),
    });
    await expect(discoverAuthorizationServer("https://idp.example.com", fetchFn))
      .rejects.toThrow(/metadata not found/);
  });

  it("rejects a non-HTTPS jwks_uri", async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        issuer: "https://idp.example.com",
        jwks_uri: "http://idp.example.com/jwks",
      }),
    });
    await expect(discoverAuthorizationServer("https://idp.example.com", fetchFn))
      .rejects.toThrow(/metadata not found/);
  });

  it("refuses to start a resource server against an HTTP issuer", async () => {
    await expect(createInboundHttpsAuth({
      inboundCfg: {
        issuer: "http://idp.example.com",
        audience: "https://mcp.example.com",
        resource: "https://mcp.example.com",
      },
      fetchFn: async () => ({ ok: false, json: async () => ({}) }),
    })).rejects.toThrow(/issuer must be an https URL/);
  });

  it("advertises the discovered issuer string in RFC 9728 authorization_servers", async () => {
    const fetchFn = async (url) => {
      if (String(url).includes("oauth-authorization-server")) {
        return {
          ok: true,
          json: async () => ({
            issuer: "https://idp.example.com/",
            jwks_uri: "https://idp.example.com/jwks",
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    };
    const inbound = await createInboundHttpsAuth({
      inboundCfg: {
        issuer: "https://idp.example.com",
        audience: "https://mcp.example.com",
        resource: "https://mcp.example.com",
      },
      fetchFn,
    });
    expect(inbound.protectedResource.authorization_servers).toEqual(["https://idp.example.com/"]);
  });

  it("refuses to start a resource server against an HTTP introspection URL", async () => {
    await expect(createInboundHttpsAuth({
      inboundCfg: {
        issuer: "https://idp.example.com",
        audience: "https://mcp.example.com",
        resource: "https://mcp.example.com",
        introspectionUrl: "http://idp.example.com/introspect",
      },
      fetchFn: async () => ({ ok: false, json: async () => ({}) }),
    })).rejects.toThrow(/introspectionUrl must be an https URL/);
  });

  it("returns null when introspection reports inactive", async () => {
    const fetchFn = async () => ({ ok: true, json: async () => ({ active: false }) });
    expect(await introspectToken("tok", {
      url: "https://idp.example.com/introspect",
      clientId: "c",
      clientSecret: "s",
      fetchFn,
    })).toBeNull();
  });

  it("attaches AbortSignal.timeout on discovery and introspection", async () => {
    const fake = new AbortController().signal;
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(fake);
    const seen = [];
    const fetchFn = async (_url, options) => {
      seen.push(options?.signal);
      return {
        ok: true,
        json: async () => ({
          issuer: "https://idp.example.com",
          jwks_uri: "https://idp.example.com/jwks",
          active: true,
        }),
      };
    };
    try {
      await discoverAuthorizationServer("https://idp.example.com", fetchFn);
      await introspectToken("tok", {
        url: "https://idp.example.com/introspect",
        clientId: "c",
        clientSecret: "s",
        fetchFn,
      });
      expect(spy).toHaveBeenCalledWith(INBOUND_IDP_TIMEOUT_MS);
      expect(seen).toEqual([fake, fake]);
    } finally {
      spy.mockRestore();
    }
  });

  it("fails closed when issuer discovery times out", async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(20));
    try {
      await expect(discoverAuthorizationServer("https://idp.example.com", hangingFetch))
        .rejects.toThrow(/metadata not found/);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects introspection with AbortError when the IdP request times out", async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(20));
    try {
      await expect(introspectToken("tok", {
        url: "https://idp.example.com/introspect",
        clientId: "c",
        clientSecret: "s",
        fetchFn: hangingFetch,
      })).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      spy.mockRestore();
    }
  });

  it("fails closed with 401 when JWKS retrieval times out", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const token = await signedToken({
      privateKey,
      issuer: "https://idp.example.com",
      audience: "https://mcp.example.com",
      claims: { sub: "agent-1", scope: "mcp_read" },
    });
    const fetchFn = async (url, options) => {
      if (String(url).includes("/jwks")) return hangingFetch(url, options);
      return {
        ok: true,
        json: async () => ({
          issuer: "https://idp.example.com",
          jwks_uri: "https://idp.example.com/jwks",
        }),
      };
    };
    const inbound = await createInboundHttpsAuth({
      inboundCfg: {
        issuer: "https://idp.example.com",
        audience: "https://mcp.example.com",
        resource: "https://mcp.example.com",
      },
      fetchFn,
    });
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(20));
    try {
      const denied = await inbound.authenticate({
        headers: { authorization: `Bearer ${token}` },
      });
      expect(denied.ok).toBe(false);
      expect(denied.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });
});

function hangingFetch(_url, opts) {
  return new Promise((_, reject) => {
    const abort = () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (opts?.signal?.aborted) {
      abort();
      return;
    }
    opts?.signal?.addEventListener("abort", abort, { once: true });
  });
}

describe("northbound token is never passed through to Drupal", () => {
  it("authHeaders only uses the site credential", () => {
    const inbound = "northbound-access-token";
    const headers = authHeaders({ apiToken: "drupal-site-token" });
    expect(headers.Authorization).toBe("Bearer drupal-site-token");
    expect(headers.Authorization).not.toContain(inbound);
  });

  it("authHeadersAsync has no inbound-token parameter", async () => {
    expect(authHeadersAsync.length).toBe(1);
    const headers = await authHeadersAsync({ apiToken: "drupal-site-token" });
    expect(headers.Authorization).toBe("Bearer drupal-site-token");
  });
});
