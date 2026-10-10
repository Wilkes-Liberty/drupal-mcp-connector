/**
 * Stub token issuer. EXPLICITLY NOT PALADIN.
 *
 * It mints JWTs with the claim set that `buildIdentity` reads today and serves
 * a discovery document and a JWKS through the `fetchFn` argument of
 * `createInboundHttpsAuth`, so the connector's real `jose` verification path
 * runs end to end. Claim names, algorithm, audience shape, and lifetime are the
 * connector's present expectations, not Paladin facts. No tenant claim is
 * minted: the connector derives no tenant from a token today.
 *
 * The issuer URL uses the reserved `.invalid` TLD and is never resolved: the
 * injected `fetchFn` is the only thing that answers for it.
 */

import { SignJWT } from "jose";
import { generateSigningKey } from "./keys.js";

export const STUB_ISSUER_URL = "https://stub-issuer.invalid";
export const STUB_AUDIENCE = "https://mcp.stub.invalid/mcp";

/** Fixture token lifetime in seconds. Not a recommendation. */
const FIXTURE_TOKEN_TTL_SEC = 300;

/**
 * @param {{issuer?: string, audience?: string, alg?: string}} [options]
 * @returns {Promise<{issuer: string, audience: string, fetchFn: typeof fetch, requested: string[], mint: Function}>}
 */
export async function createStubIssuer({
  issuer = STUB_ISSUER_URL,
  audience = STUB_AUDIENCE,
  alg = "ES256",
} = {}) {
  const key = await generateSigningKey(alg);
  const requested = [];
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const metadata = { issuer, jwks_uri: `${issuer}/jwks.json` };
  const documents = new Map([
    [`${issuer}/.well-known/oauth-authorization-server`, metadata],
    [`${issuer}/.well-known/openid-configuration`, metadata],
    [metadata.jwks_uri, { keys: [key.publicJwk] }],
  ]);

  /** Answers only for the stub issuer's own URLs; everything else is a 404. */
  async function fetchFn(input) {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    const document = documents.get(url);
    return document ? json(document) : new Response("not found", { status: 404 });
  }

  /**
   * Mint a signed JWT. `claims` override the defaults; `undefined` drops a claim.
   * @param {object} claims
   * @param {{ttlSec?: number}} [options]
   * @returns {Promise<string>}
   */
  async function mint(claims = {}, { ttlSec = FIXTURE_TOKEN_TTL_SEC } = {}) {
    const merged = { iss: issuer, aud: audience, ...claims };
    const { iss, aud, sub, ...rest } = merged;
    const jwt = new SignJWT(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)))
      .setProtectedHeader({ alg: key.alg, kid: key.kid })
      .setIssuedAt()
      .setExpirationTime(`${ttlSec}s`);
    if (iss !== undefined) jwt.setIssuer(iss);
    if (aud !== undefined) jwt.setAudience(aud);
    if (sub !== undefined) jwt.setSubject(sub);
    return jwt.sign(key.privateKey);
  }

  return { issuer, audience, fetchFn, requested, mint };
}
