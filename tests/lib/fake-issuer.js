/**
 * In-process RFC 7662 issuer fixture. EXPLICITLY NOT PALADIN.
 *
 * Serves discovery, JWKS, and token introspection through an injected fetch
 * so tests never open a real network socket. The issuer URL uses a reserved
 * `.invalid` host. Tokens are minted in memory; `revoke` / `down` / `hang`
 * flip the next introspection answer without a process restart.
 */

import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";

export const FAKE_ISSUER_URL = "https://issuer.test";
export const FAKE_AUDIENCE = "https://mcp.example.com/mcp";
export const FAKE_INTROSPECTION_URL = `${FAKE_ISSUER_URL}/introspect`;

const FIXTURE_TTL_SEC = 300;

/**
 * @param {object} [options]
 * @param {string} [options.issuer]
 * @param {string} [options.audience]
 * @param {string} [options.alg]
 * @returns {Promise<object>}
 */
export async function createFakeIssuer({
  issuer = FAKE_ISSUER_URL,
  audience = FAKE_AUDIENCE,
  alg = "RS256",
} = {}) {
  const { publicKey, privateKey } = await generateKeyPair(alg);
  const jwk = await exportJWK(publicKey);
  jwk.kid = "fake-issuer";
  jwk.alg = alg;
  jwk.use = "sig";

  const introspectionUrl = `${issuer.replace(/\/+$/, "")}/introspect`;
  const revokedJti = new Set();
  const revokedTokens = new Set();
  let mode = "up";
  const introspectCalls = [];

  const metadata = { issuer, jwks_uri: `${issuer}/jwks.json`, introspection_endpoint: introspectionUrl };
  const documents = new Map([
    [`${issuer}/.well-known/oauth-authorization-server`, metadata],
    [`${issuer}/.well-known/openid-configuration`, metadata],
    [metadata.jwks_uri, { keys: [jwk] }],
  ]);

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function readBody(input, init) {
    if (init?.body != null) return String(init.body);
    if (input instanceof Request) return input.text();
    return "";
  }

  async function fetchFn(input, init = {}) {
    const url = String(input instanceof Request ? input.url : input).split("?")[0];
    const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (url === introspectionUrl && method === "POST") {
      introspectCalls.push({ url, method });
      if (mode === "down") {
        throw new Error("issuer introspection unreachable");
      }
      if (mode === "hang") {
        return new Promise((_, reject) => {
          const abort = () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (init.signal?.aborted) {
            abort();
            return;
          }
          init.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      const token = new URLSearchParams(await readBody(input, init)).get("token") || "";
      if (revokedTokens.has(token)) return json({ active: false });
      let claims;
      try {
        claims = decodeJwt(token);
      } catch {
        return json({ active: false });
      }
      if (claims.jti && revokedJti.has(String(claims.jti))) return json({ active: false });
      if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) {
        return json({ active: false });
      }
      return json({ active: true, ...claims });
    }

    const document = documents.get(url);
    return document ? json(document) : new Response("not found", { status: 404 });
  }

  /**
   * @param {object} [claims]
   * @param {{ttlSec?: number, includeIss?: boolean, includeAud?: boolean}} [options]
   * @returns {Promise<string>}
   */
  async function mint(claims = {}, { ttlSec = FIXTURE_TTL_SEC, includeIss = true, includeAud = true } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const { iss, aud, sub, iat, exp, ...rest } = claims;
    let jwt = new SignJWT(Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    ))
      .setProtectedHeader({ alg, kid: "fake-issuer" })
      .setSubject(sub ?? "agent-1")
      .setIssuedAt(iat ?? now)
      .setExpirationTime(exp ?? now + ttlSec);
    if (includeIss && iss !== undefined) jwt = jwt.setIssuer(iss);
    else if (includeIss) jwt = jwt.setIssuer(issuer);
    if (includeAud && aud !== undefined) jwt = jwt.setAudience(aud);
    else if (includeAud) jwt = jwt.setAudience(audience);
    return jwt.sign(privateKey);
  }

  return {
    issuer,
    audience,
    introspectionUrl,
    fetchFn,
    mint,
    introspectCalls,
    revoke(tokenOrJti) {
      if (typeof tokenOrJti === "string" && tokenOrJti.includes(".")) {
        revokedTokens.add(tokenOrJti);
        try {
          const claims = decodeJwt(tokenOrJti);
          if (claims.jti) revokedJti.add(String(claims.jti));
        } catch {
          // opaque token id
        }
        return;
      }
      revokedJti.add(String(tokenOrJti));
    },
    setMode(next) {
      mode = next;
    },
  };
}
