import { describe, it, expect } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
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
  authorizationServerDiscoveryUrls,
  discoverAuthorizationServer,
  introspectToken,
  resolveInboundAuthMode,
  resolveInboundAuthConfig,
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

  it("allows an explicit unauthenticated trusted-proxy front", () => {
    expect(resolveInboundAuthMode({
      bindHost: "0.0.0.0",
      allowUnauth: true,
    }).mode).toBe("unauthenticated");
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
});

async function signedToken({ privateKey, kid = "test", claims = {}, issuer, audience, exp = "5m" }) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(exp)
    .setSubject(claims.sub ?? "agent-1")
    .sign(privateKey);
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
    return { privateKey, jwks };
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
    const authenticateOpaque = createResourceAuthenticator({
      issuer,
      audience,
      verifyJwt: async () => { throw new Error("not a jwt"); },
      introspect: async (token) => token === "opaque-ok"
        ? { active: true, sub: "agent-9", iss: issuer, aud: audience, scope: "mcp_read" }
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
});

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
