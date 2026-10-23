/**
 * Paladin / grok-bot hosted-MCP token shape (DEV-1052).
 *
 * Live production (`https://mcp.wilkesliberty.com/mcp`) requires
 * `aud === https://mcp.wilkesliberty.com/mcp`. The grok-bot
 * `hosted-mcp-audience` mapper historically stamped the staging resource
 * on every client. The network path also used RFC 7662 introspection
 * claims for `aud`; Keycloak often returns only the first audience
 * (`account`) there even when the signed JWT carries the resource URL.
 *
 * These cases use in-process keys. They are not Paladin.
 */

import { describe, it, expect } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { createResourceAuthenticator } from "../../src/lib/http-auth.js";

const ISSUER = "https://auth.wilkesliberty.com/realms/wilkesliberty";
const PROD_AUD = "https://mcp.wilkesliberty.com/mcp";
const STAGING_AUD = "https://mcp.staging.wilkesliberty.com/mcp";
const METADATA = "https://mcp.wilkesliberty.com/.well-known/oauth-protected-resource/mcp";

/**
 * Claims Paladin actually emits for a grok-bot authorization-code token.
 * `aud` is passed separately so each case can set the mapper value.
 *
 * @param {object} [extra]
 * @returns {object}
 */
function paladinGrokBotClaims(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    typ: "Bearer",
    azp: "grok-bot",
    scope: "mcp_read",
    realm_access: { roles: ["mcp-access"] },
    resource_access: { account: { roles: ["manage-account", "view-profile"] } },
    iat: now,
    exp: now + 300,
    ...extra,
  };
}

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "paladin-test";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

/**
 * @param {object} options
 * @param {import("jose").KeyLike} options.privateKey
 * @param {string|string[]} options.audience
 * @param {object} [options.claims]
 * @returns {Promise<string>}
 */
async function mintPaladinToken({ privateKey, audience, claims = {} }) {
  const payload = paladinGrokBotClaims(claims);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "paladin-test", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(payload.sub)
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(privateKey);
}

/**
 * Hosted production authenticator: live introspection plus JWKS.
 *
 * @param {object} options
 * @param {import("jose").JWTVerifyGetKey} options.jwks
 * @param {(token: string) => Promise<object|null>} options.introspect
 */
function productionAuthenticator({ jwks, introspect }) {
  return createResourceAuthenticator({
    issuer: ISSUER,
    audience: PROD_AUD,
    requiredScopes: ["mcp_read"],
    jwks,
    introspect,
    requireIntrospection: true,
    resourceMetadataUrl: METADATA,
  });
}

describe("Paladin grok-bot audience against production hosted MCP", () => {
  it("rejects the live grok-bot mapper value (staging resource) on the production plane", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await mintPaladinToken({
      privateKey,
      audience: ["account", STAGING_AUD],
    });
    const authenticate = productionAuthenticator({
      jwks,
      introspect: async () => ({
        active: true,
        ...paladinGrokBotClaims(),
        iss: ISSUER,
        aud: ["account", STAGING_AUD],
      }),
    });

    const denied = await authenticate(`Bearer ${token}`);
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
    expect(denied.headers["WWW-Authenticate"]).toContain("error=\"invalid_token\"");
    expect(denied.headers["WWW-Authenticate"]).toContain("Audience mismatch");
  });

  it("rejects a verified JWT whose aud is only the staging resource even if introspection names production", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await mintPaladinToken({
      privateKey,
      audience: STAGING_AUD,
    });
    const authenticate = productionAuthenticator({
      jwks,
      introspect: async () => ({
        active: true,
        ...paladinGrokBotClaims(),
        iss: ISSUER,
        aud: PROD_AUD,
      }),
    });

    const denied = await authenticate(`Bearer ${token}`);
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
    expect(denied.headers["WWW-Authenticate"]).toContain("Audience mismatch");
  });

  it("admits a grok-bot JWT whose aud includes the production resource when introspection only returns account", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await mintPaladinToken({
      privateKey,
      audience: ["account", PROD_AUD],
    });
    const authenticate = productionAuthenticator({
      jwks,
      introspect: async () => ({
        active: true,
        ...paladinGrokBotClaims(),
        iss: ISSUER,
        // Keycloak introspection often serializes only the default audience.
        aud: "account",
        azp: "grok-bot",
      }),
    });

    const allowed = await authenticate(`Bearer ${token}`);
    expect(allowed.ok).toBe(true);
    expect(allowed.identity.sub).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(allowed.identity.azp).toBe("grok-bot");
    expect(allowed.identity.scopes).toEqual(["mcp_read"]);
    expect(allowed.identity.aud).toEqual(["account", PROD_AUD]);
  });

  it("still refuses when introspection says the Paladin token is inactive", async () => {
    const { privateKey, jwks } = await fixture();
    const token = await mintPaladinToken({
      privateKey,
      audience: ["account", PROD_AUD],
    });
    const authenticate = productionAuthenticator({
      jwks,
      introspect: async () => null,
    });

    const denied = await authenticate(`Bearer ${token}`);
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(401);
    expect(denied.headers["WWW-Authenticate"]).toContain("Token is not active");
  });
});
