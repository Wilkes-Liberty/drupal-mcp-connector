/**
 * Inbound authentication for the HTTPS MCP transport.
 *
 * One authenticated mode. The loopback shared bearer (`MCP_AUTH_TOKEN`) was
 * removed in 4.0.0 (#231); setting it is fatal at startup.
 *   - OAuth resource server (`createResourceAuthenticator`) — network-facing
 *     HTTPS. Every authenticated network call is validated by RFC 7662
 *     introspection at the single configured issuer (DEV-844). There is no
 *     positive cache: a revoke takes effect on the next call. Introspection
 *     unreachable / timeout / error is 503 and does not dispatch; inactive is
 *     401. `iss` must be present and equal the configured issuer; audience is
 *     an exact match against the one configured plane. JWT algorithms are
 *     pinned (`none` never; `HS*` only when explicitly configured). The
 *     revocation file is not an authority on network admission. Stdio has
 *     no bearer authentication and no revocation path. Bearer tokens must
 *     carry `exp` and `iat` and stay within `auth.maxTokenLifetime`.
 *     Caller-supplied identity headers
 *     never become the principal. Issuer discovery / JWKS abort after
 *     `INBOUND_IDP_TIMEOUT_MS` (30s). Introspection aborts after
 *     `DEFAULT_INTROSPECTION_TIMEOUT_MS` (2s, configurable).
 */

import { readFileSync, statSync, writeFileSync } from "fs";
import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify } from "jose";

/** Inbound IdP HTTP timeout (discovery / JWKS). Matches Drupal/Drush outbound HTTP. */
export const INBOUND_IDP_TIMEOUT_MS = 30_000;

/**
 * Default RFC 7662 introspection timeout. A stuck issuer fails closed with
 * 503; operators raise `auth.introspectionTimeoutMs` or
 * `MCP_INTROSPECTION_TIMEOUT_MS` when the authorization server is known to
 * be slower. There is no positive cache.
 */
export const DEFAULT_INTROSPECTION_TIMEOUT_MS = 2000;

/**
 * In-process guard (DEV-844). Production leaves `required` true. The only
 * way to relax it is {@link setNetworkIntrospectionGuard}, which tests call
 * in-process. No environment variable is read. When `required` is false,
 * the resource-server path may admit a JWT without a live introspection
 * result — the pre-DEV-844 behavior used to prove deny tests can fail.
 */
export const NETWORK_INTROSPECTION_GUARD = { required: true };

/**
 * Flip {@link NETWORK_INTROSPECTION_GUARD} for a red-run. Restore `true`
 * after the assertion; production code never calls this.
 *
 * @param {boolean} required
 * @returns {void}
 */
export function setNetworkIntrospectionGuard(required) {
  NETWORK_INTROSPECTION_GUARD.required = Boolean(required);
}

/**
 * Whether the hosted resource-server path must introspect every bearer.
 * Environment variables cannot turn this off.
 *
 * @returns {boolean}
 */
export function networkIntrospectionRequired() {
  return NETWORK_INTROSPECTION_GUARD.required;
}

/**
 * Default maximum bearer lifetime in seconds (`exp - iat`). One hour is
 * conservative for access tokens; operators with longer-lived issuers raise
 * `auth.maxTokenLifetime`.
 */
export const DEFAULT_MAX_TOKEN_LIFETIME = 3600;

/**
 * Default JWS algorithms accepted on the hosted resource-server path.
 * Asymmetric only — `none` and HMAC (`HS*`) are excluded so a public JWKS
 * key cannot be reused as a shared secret. Operators pin a narrower list
 * with `auth.algorithms` when the issuer uses a subset. `HS*` is accepted
 * only when the operator names it explicitly.
 */
export const DEFAULT_TOKEN_ALGORITHMS = Object.freeze([
  "RS256", "RS384", "RS512",
  "ES256", "ES384", "ES512",
  "PS256", "PS384", "PS512",
  "EdDSA",
]);

const FORBIDDEN_TOKEN_ALGS = new Set(["none"]);
const HMAC_TOKEN_ALGS = new Set(["HS256", "HS384", "HS512"]);

/**
 * Attach an inbound IdP abort timeout. A caller `signal` wins.
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {RequestInit}
 */
function withInboundTimeout(options = {}, timeoutMs = INBOUND_IDP_TIMEOUT_MS) {
  return {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(timeoutMs),
  };
}

/** Header names that must never become identity. */
export const SPOOFABLE_IDENTITY_HEADERS = Object.freeze([
  "x-mcp-subject",
  "x-mcp-actor",
  "x-mcp-user",
  "x-forwarded-user",
  "x-forwarded-sub",
]);

/**
 * Extract the raw bearer token from an Authorization header.
 * @param {unknown} authorizationHeader
 * @returns {?string}
 */
export function parseBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string") return null;
  if (!authorizationHeader.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * Normalize a JWT `scope` / `scp` claim to a string list.
 * @param {unknown} scope
 * @returns {string[]}
 */
export function scopesFromClaim(scope) {
  if (Array.isArray(scope)) return scope.map((item) => String(item)).filter(Boolean);
  if (typeof scope === "string") return scope.split(/[\s,]+/).filter(Boolean);
  return [];
}

/**
 * Freeze a request identity from validated claims. Caller headers are not an input.
 * @param {object} claims
 * @returns {Readonly<{sub: ?string, iss: ?string, aud: string|string[]|null, scopes: readonly string[], sites: readonly string[]|null, exp: ?number, nbf: ?number, jti: ?string, clientId: ?string, actSub: ?string}>}
 */
export function buildIdentity(claims) {
  const scopes = scopesFromClaim(claims.scope ?? claims.scp);
  const aud = claims.aud;
  const siteClaim = claims.sites ?? claims.mcp_sites;
  let sites = null;
  if (Array.isArray(siteClaim)) {
    sites = Object.freeze(siteClaim.map(String).filter(Boolean));
  } else if (typeof siteClaim === "string") {
    sites = Object.freeze(siteClaim.split(/[\s,]+/).filter(Boolean));
  }
  return Object.freeze({
    sub: claims.sub === undefined || claims.sub === null ? null : String(claims.sub),
    iss: claims.iss === undefined || claims.iss === null ? null : String(claims.iss),
    aud: Array.isArray(aud)
      ? Object.freeze(aud.map(String))
      : (aud === undefined || aud === null ? null : String(aud)),
    scopes: Object.freeze([...scopes]),
    sites,
    exp: typeof claims.exp === "number" ? claims.exp : null,
    nbf: typeof claims.nbf === "number" ? claims.nbf : null,
    jti: claims.jti === undefined || claims.jti === null ? null : String(claims.jti),
    clientId: (claims.azp === undefined || claims.azp === null)
      && (claims.client_id === undefined || claims.client_id === null)
      ? null
      : String(claims.azp ?? claims.client_id),
    actSub: (claims.act && typeof claims.act === "object" && !Array.isArray(claims.act)
      && typeof claims.act.sub === "string" && claims.act.sub.trim())
      ? claims.act.sub.trim()
      : null,
  });
}

/**
 * @param {{scopes?: readonly string[]}} identity
 * @param {string[]} required
 * @returns {boolean}
 */
export function identityHasScopes(identity, required) {
  if (!required?.length) return true;
  const have = new Set(identity.scopes ?? []);
  return required.every((scope) => have.has(scope));
}

function escapeAuthParam(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/**
 * Build a RFC 6750 / RFC 9728 WWW-Authenticate value.
 * @param {object} [fields]
 * @returns {string}
 */
export function formatWwwAuthenticate({
  realm = "mcp",
  error,
  errorDescription,
  scope,
  resourceMetadata,
} = {}) {
  const parts = [`Bearer realm="${realm}"`];
  if (error) parts.push(`error="${error}"`);
  if (errorDescription) parts.push(`error_description="${escapeAuthParam(errorDescription)}"`);
  if (scope) parts.push(`scope="${scope}"`);
  if (resourceMetadata) parts.push(`resource_metadata="${resourceMetadata}"`);
  return parts.join(", ");
}

/**
 * Headers for a Bearer challenge. Every connector 401/403 challenge
 * is built here so `resource_metadata` cannot drift off the RFC 9728 URL.
 *
 * @param {object} [fields]
 * @param {string} [fields.error]
 * @param {string} [fields.errorDescription]
 * @param {string} [fields.scope]
 * @param {string} [fields.resourceMetadata]
 * @returns {{ "WWW-Authenticate": string }}
 */
export function unauthorizedChallenge({
  error,
  errorDescription,
  scope,
  resourceMetadata,
} = {}) {
  return {
    "WWW-Authenticate": formatWwwAuthenticate({
      error,
      errorDescription,
      scope,
      resourceMetadata,
    }),
  };
}

/**
 * Write a 401 with a Bearer challenge. The only 401 writer in src/.
 *
 * @param {import("http").ServerResponse} res
 * @param {object} [fields]
 * @param {string} [fields.error]
 * @param {string} [fields.errorDescription]
 * @param {string} [fields.scope]
 * @param {string} [fields.resourceMetadata]
 * @param {string} [fields.body]
 */
export function writeUnauthorized(res, {
  error = "invalid_token",
  errorDescription,
  scope,
  resourceMetadata,
  body = "Unauthorized",
} = {}) {
  res.writeHead(401, unauthorizedChallenge({
    error,
    errorDescription,
    scope,
    resourceMetadata,
  })).end(body);
}

/**
 * RFC 9728 Protected Resource Metadata document.
 * @param {object} fields
 * @returns {object}
 */
export function protectedResourceMetadata({
  resource,
  authorizationServers,
  scopesSupported = [],
}) {
  return {
    resource,
    authorization_servers: [...authorizationServers],
    bearer_methods_supported: ["header"],
    scopes_supported: [...scopesSupported],
  };
}

/**
 * RFC 9728 well-known URL for a resource identifier.
 * @param {string} resource
 * @returns {string}
 */
export function resourceMetadataUrlFor(resource) {
  const url = new URL(resource);
  const trimmed = url.pathname.replace(/\/+$/, "");
  const suffix = trimmed === "" || trimmed === "/" ? "" : trimmed.replace(/^\//, "");
  url.pathname = suffix
    ? `/.well-known/oauth-protected-resource/${suffix}`
    : "/.well-known/oauth-protected-resource";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * @param {number} status
 * @param {object} fields
 * @returns {{ok: false, status: number, headers: object, body: string}}
 */
export function denyAuth(status, {
  error,
  errorDescription,
  scope,
  resourceMetadata,
  body,
} = {}) {
  return {
    ok: false,
    status,
    headers: unauthorizedChallenge({
      error,
      errorDescription,
      scope,
      resourceMetadata,
    }),
    body: body ?? (status === 403 ? "Forbidden" : "Unauthorized"),
  };
}

/**
 * Fail-closed response when the issuer cannot be reached. Not a 401: the
 * bearer was not proven inactive; dispatch must not run.
 *
 * @param {object} [fields]
 * @param {string} [fields.body]
 * @param {number} [fields.retryAfterSec]
 * @returns {{ok: false, status: 503, headers: object, body: string}}
 */
export function denyUnavailable({
  body = "Authorization server unavailable",
  retryAfterSec = 2,
} = {}) {
  return {
    ok: false,
    status: 503,
    headers: { "Retry-After": String(retryAfterSec) },
    body,
  };
}

/**
 * @param {object} identity
 * @returns {{ok: true, identity: object}}
 */
export function allowAuth(identity) {
  return { ok: true, identity };
}

/**
 * Normalize a configured maximum token lifetime to a positive integer.
 * Invalid or missing values fall back to {@link DEFAULT_MAX_TOKEN_LIFETIME}.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeMaxTokenLifetime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TOKEN_LIFETIME;
  return Math.floor(n);
}

/**
 * Normalize a configured JWS algorithm allowlist. `none` is stripped even
 * when an operator names it. HMAC (`HS*`) is kept only when the operator
 * names it; the implicit default never includes it. An empty list after
 * filtering uses the default.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeTokenAlgorithms(value) {
  const explicit = Array.isArray(value) || (typeof value === "string" && value.trim());
  let list;
  if (Array.isArray(value)) {
    list = value.map(String);
  } else if (typeof value === "string" && value.trim()) {
    list = value.split(/[\s,]+/).filter(Boolean);
  } else {
    list = [...DEFAULT_TOKEN_ALGORITHMS];
  }
  const allowed = list.filter((alg) => {
    if (!alg || FORBIDDEN_TOKEN_ALGS.has(alg.toLowerCase())) return false;
    if (!explicit && HMAC_TOKEN_ALGS.has(alg)) return false;
    return true;
  });
  return allowed.length ? allowed : [...DEFAULT_TOKEN_ALGORITHMS];
}

/**
 * Normalize a configured introspection timeout to a positive integer.
 * Invalid or missing values fall back to {@link DEFAULT_INTROSPECTION_TIMEOUT_MS}.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeIntrospectionTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTROSPECTION_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * Shared `exp` / `iat` / lifetime checks for JWT claims and RFC 7662
 * introspection results. Missing `exp` or `iat`, an expired `exp`, a
 * not-yet-valid `nbf`, a future `iat` (beyond `clockTolerance`),
 * `exp - iat` above the cap, or an `iat` older than the cap are refused.
 * @param {object} claims
 * @param {object} [options]
 * @param {number} [options.maxTokenLifetime]
 * @param {number} [options.clockTolerance]
 * @param {number} [options.now]
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function validateBearerTimeClaims(claims, {
  maxTokenLifetime = DEFAULT_MAX_TOKEN_LIFETIME,
  clockTolerance = 5,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  if (typeof claims?.exp !== "number" || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: "Token is missing exp" };
  }
  if (typeof claims?.iat !== "number" || !Number.isFinite(claims.iat)) {
    return { ok: false, reason: "Token is missing iat" };
  }
  // `exp` is an exclusive boundary (RFC 7519 §4.1.4), matching jose.
  if (claims.exp <= now - clockTolerance) {
    return { ok: false, reason: "Token has expired" };
  }
  if (typeof claims.nbf === "number" && claims.nbf > now + clockTolerance) {
    return { ok: false, reason: "Token is not yet valid" };
  }
  if (claims.iat > now + clockTolerance) {
    return { ok: false, reason: "Token iat is in the future" };
  }
  if (claims.exp - claims.iat > maxTokenLifetime) {
    return { ok: false, reason: "Token lifetime exceeds maximum" };
  }
  if (now - claims.iat > maxTokenLifetime + clockTolerance) {
    return { ok: false, reason: "Token is too old" };
  }
  return { ok: true };
}

/**
 * Refuse a compact JWS whose protected header names an algorithm outside
 * the allowlist before any introspection fallback, so a token the local
 * verifier rejected for its algorithm cannot be re-admitted as "opaque".
 * A token that is not a decodable three-segment JWS is left to
 * introspection.
 * @param {string} token
 * @param {string[]} allowedAlgs
 * @returns {?string} Refusal reason, or null when the token may proceed.
 */
export function compactJwtAlgorithmRefusal(token, allowedAlgs) {
  if (typeof token !== "string" || token.split(".").length !== 3) return null;
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  if (typeof header.alg !== "string" || !allowedAlgs.includes(header.alg)) {
    return "Token algorithm is not allowed";
  }
  return null;
}

function audienceMatches(aud, expected) {
  if (aud === undefined || aud === null) return false;
  if (Array.isArray(aud)) return aud.includes(expected);
  return aud === expected;
}

function normalizeIssuer(issuer) {
  return String(issuer).replace(/\/+$/, "");
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * RFC 8414 inserts `.well-known` between host and path. OIDC Discovery
 * appends `/.well-known/openid-configuration` to the issuer identifier.
 * @param {string} issuer
 * @returns {string[]}
 */
export function authorizationServerDiscoveryUrls(issuer) {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const hasPath = path && path !== "/";
  const rfc8414 = `${url.origin}/.well-known/oauth-authorization-server${hasPath ? path : ""}`;
  const oidc = `${normalizeIssuer(issuer)}/.well-known/openid-configuration`;
  return [rfc8414, oidc];
}

/**
 * Hot-reloaded revocation list. The file is re-read when its mtime changes, so
 * a revoke takes effect without restarting the process.
 *
 * Shape: `{ "jti": ["…"], "sub": ["…"] }`.
 *
 * @param {object} options
 * @param {string} [options.filePath]
 * @returns {{
 *   isRevoked: (identity: {jti?: ?string, sub?: ?string}) => boolean,
 *   revoke: (identity: {jti?: ?string}) => {ok: true}|{ok: false, reason: string},
 * }}
 */
export function createRevocationStore({
  filePath,
  readFile = readFileSync,
  writeFile = writeFileSync,
  stat = statSync,
} = {}) {
  let cache = { mtimeMs: Number.NaN, jti: new Set(), sub: new Set(), denyAll: false };

  function load() {
    if (!filePath) return cache;
    let info;
    try {
      info = stat(filePath);
    } catch {
      cache = { mtimeMs: Number.NaN, jti: new Set(), sub: new Set(), denyAll: false };
      return cache;
    }
    if (info.mtimeMs === cache.mtimeMs) return cache;
    try {
      const raw = JSON.parse(readFile(filePath, "utf8"));
      cache = {
        mtimeMs: info.mtimeMs,
        jti: new Set((raw.jti ?? []).map(String)),
        sub: new Set((raw.sub ?? []).map(String)),
        denyAll: false,
      };
    } catch {
      // File exists but is unreadable or not JSON — fail closed.
      cache = { mtimeMs: info.mtimeMs, jti: new Set(), sub: new Set(), denyAll: true };
    }
    return cache;
  }

  return {
    isRevoked(identity) {
      const { jti, sub, denyAll } = load();
      if (denyAll) return true;
      if (identity.jti && jti.has(identity.jti)) return true;
      if (identity.sub && sub.has(identity.sub)) return true;
      return false;
    },

    /**
     * Persist one jti and apply it in-process. The next authenticate does
     * not wait on mtime; a leftover file still denies after restart.
     *
     * @param {{jti?: ?string}} identity
     * @returns {{ok: true}|{ok: false, reason: string}}
     */
    revoke(identity) {
      const tokenId = typeof identity?.jti === "string" ? identity.jti.trim() : "";
      if (!tokenId || !filePath) {
        return { ok: false, reason: "unreadable" };
      }
      let exists = false;
      try {
        stat(filePath);
        exists = true;
      } catch (err) {
        if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") {
          return { ok: false, reason: "unreadable" };
        }
      }
      let raw;
      if (exists) {
        try {
          raw = JSON.parse(readFile(filePath, "utf8"));
        } catch {
          return { ok: false, reason: "unreadable" };
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return { ok: false, reason: "unreadable" };
        }
      } else {
        raw = { jti: [], sub: [] };
      }
      const nextJti = new Set([...(raw.jti ?? []).map(String), tokenId]);
      const nextSub = new Set((raw.sub ?? []).map(String));
      try {
        writeFile(filePath, JSON.stringify({ jti: [...nextJti], sub: [...nextSub] }));
      } catch {
        return { ok: false, reason: "unreadable" };
      }
      cache = {
        mtimeMs: Number.NaN,
        jti: nextJti,
        sub: nextSub,
        denyAll: false,
      };
      return { ok: true };
    },
  };
}

/**
 * Fetch RFC 8414 / OIDC authorization-server metadata for an issuer.
 * @param {string} issuer
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object>}
 */
export async function discoverAuthorizationServer(issuer, fetchFn = fetch) {
  if (!isHttpsUrl(issuer)) {
    throw new Error(`Authorization server issuer must be HTTPS: ${issuer}`);
  }
  const expected = normalizeIssuer(issuer);
  for (const url of authorizationServerDiscoveryUrls(issuer)) {
    let res;
    try {
      res = await fetchFn(url, withInboundTimeout({ headers: { accept: "application/json" } }));
    } catch {
      continue;
    }
    if (!res.ok) continue;
    let body;
    try {
      body = await res.json();
    } catch {
      continue;
    }
    // RFC 8414 §3.3: metadata issuer must match the identifier we queried.
    if (normalizeIssuer(body.issuer) !== expected) continue;
    if (!isHttpsUrl(body.jwks_uri)) continue;
    return body;
  }
  throw new Error(`Authorization server metadata not found for issuer ${issuer}`);
}

/**
 * RFC 7662 token introspection. Returns claims when active, otherwise null.
 * HTTP errors, timeouts, and unreadable bodies throw so the caller can fail
 * closed with 503. `active !== true` is inactive (401), not an outage.
 *
 * @param {string} token
 * @param {object} options
 * @returns {Promise<object|null>}
 */
export async function introspectToken(token, {
  url,
  clientId,
  clientSecret,
  fetchFn = fetch,
  timeoutMs = DEFAULT_INTROSPECTION_TIMEOUT_MS,
}) {
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetchFn(url, withInboundTimeout({
    method: "POST",
    headers: {
      authorization: `Basic ${creds}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({ token }).toString(),
  }, timeoutMs));
  if (!res.ok) {
    throw new Error(`introspection HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.active !== true) return null;
  return body;
}

/**
 * Authenticate one inbound request as an OAuth protected resource.
 *
 * `requestHeaders` is accepted so callers can pass the full header map; those
 * headers are deliberately unused. Identity comes only from the validated token.
 *
 * @param {object} options
 * @param {string} [options.issuer]
 * @param {string} [options.audience]
 * @param {string[]} [options.requiredScopes]
 * @param {string} [options.resourceMetadataUrl]
 * @param {import("jose").JWTVerifyGetKey} [options.jwks]
 * @param {(token: string) => Promise<object>} [options.verifyJwt]
 * @param {(token: string) => Promise<object|null>} [options.introspect]
 * @param {{isRevoked: Function}} [options.revocationStore]
 * @param {number} [options.clockTolerance]
 * @param {number} [options.maxTokenLifetime] Seconds; default {@link DEFAULT_MAX_TOKEN_LIFETIME}.
 * @param {string[]} [options.algorithms] JWS allowlist; default {@link DEFAULT_TOKEN_ALGORITHMS}.
 * @param {Array<{clientId: string, sub: string}>} [options.allowedPrincipals] Exact
 *   client/subject pairs within the configured issuer; an empty list denies all.
 * @param {boolean} [options.requireIntrospection] Network path (DEV-844): introspect
 *   every bearer, 503 on issuer outage, ignore the revocation file.
 * @returns {(authorizationHeader: unknown, requestHeaders?: object) => Promise<object>}
 */
export function createResourceAuthenticator({
  issuer,
  audience,
  requiredScopes = [],
  resourceMetadataUrl,
  jwks,
  verifyJwt,
  introspect,
  revocationStore,
  clockTolerance = 5,
  maxTokenLifetime = DEFAULT_MAX_TOKEN_LIFETIME,
  algorithms = DEFAULT_TOKEN_ALGORITHMS,
  requireIntrospection = false,
  allowedPrincipals,
}) {
  const fail = (status, extra) => denyAuth(status, { resourceMetadata: resourceMetadataUrl, ...extra });
  const expectedIssuer = issuer ? normalizeIssuer(issuer) : "";
  const lifetimeCap = normalizeMaxTokenLifetime(maxTokenLifetime);
  const allowedAlgs = normalizeTokenAlgorithms(algorithms);
  const admission = normalizeAllowedPrincipals(allowedPrincipals);

  async function claimsFromJwt(token) {
    if (verifyJwt) return verifyJwt(token);
    if (!jwks) throw new Error("missing JWKS");
    const { payload } = await jwtVerify(token, jwks, {
      issuer: expectedIssuer ? [expectedIssuer, `${expectedIssuer}/`] : undefined,
      audience,
      clockTolerance,
      requiredClaims: ["exp", "iat"],
      maxTokenAge: lifetimeCap,
      algorithms: allowedAlgs,
    });
    return payload;
  }

  return async function authenticate(authorizationHeader, requestHeaders = {}) {
    void requestHeaders;
    const token = parseBearerToken(authorizationHeader);
    if (!token) {
      return fail(401, { error: "invalid_token", errorDescription: "Bearer token required" });
    }

    const algorithmRefusal = compactJwtAlgorithmRefusal(token, allowedAlgs);
    if (algorithmRefusal) {
      return fail(401, { error: "invalid_token", errorDescription: algorithmRefusal });
    }

    let claims = null;
    if (requireIntrospection) {
      if (!introspect) return denyUnavailable();
      try {
        claims = await introspect(token);
      } catch {
        return denyUnavailable();
      }
      if (!claims) {
        return fail(401, { error: "invalid_token", errorDescription: "Token is not active" });
      }
    } else {
      let jwtOk = false;
      try {
        claims = await claimsFromJwt(token);
        jwtOk = true;
      } catch {
        claims = null;
      }

      if (!jwtOk) {
        if (!introspect) {
          return fail(401, { error: "invalid_token", errorDescription: "Token validation failed" });
        }
        try {
          claims = await introspect(token);
        } catch {
          claims = null;
        }
        if (!claims) {
          return fail(401, { error: "invalid_token", errorDescription: "Token is not active" });
        }
      } else if (introspect) {
        let active;
        try {
          active = await introspect(token);
        } catch {
          active = null;
        }
        if (!active) {
          return fail(401, { error: "invalid_token", errorDescription: "Token is not active" });
        }
      }
    }

    const timeCheck = validateBearerTimeClaims(claims, {
      maxTokenLifetime: lifetimeCap,
      clockTolerance,
    });
    if (!timeCheck.ok) {
      return fail(401, { error: "invalid_token", errorDescription: timeCheck.reason });
    }

    // Exactly one configured issuer: missing or unequal `iss` is 401.
    if (!expectedIssuer || !claims.iss || normalizeIssuer(claims.iss) !== expectedIssuer) {
      return fail(401, { error: "invalid_token", errorDescription: "Issuer mismatch" });
    }
    if (!audience || !audienceMatches(claims.aud, audience)) {
      return fail(401, { error: "invalid_token", errorDescription: "Audience mismatch" });
    }

    const identity = buildIdentity(claims);
    // Network admission is the live introspection result (DEV-844). Stdio
    // never builds this authenticator, so the file is not a stdio deny.
    // It applies only when introspection is not required.
    if (!requireIntrospection && revocationStore?.isRevoked(identity)) {
      return fail(401, { error: "invalid_token", errorDescription: "Token has been revoked" });
    }
    if (!identityHasScopes(identity, requiredScopes)) {
      return fail(403, {
        error: "insufficient_scope",
        scope: requiredScopes.join(" "),
        errorDescription: "Required scope is missing",
        body: "Forbidden",
      });
    }
    if (admission !== undefined) {
      // Compare verified claims without coercion. If an issuer supplies both
      // client claims, they must agree; headers and display names are irrelevant.
      const clientId = claims.azp ?? claims.client_id;
      const unambiguous = claims.azp === undefined || claims.azp === null
        || claims.client_id === undefined || claims.client_id === null
        || claims.azp === claims.client_id;
      if (!unambiguous || typeof clientId !== "string" || typeof claims.sub !== "string"
        || !admission.some((entry) => entry.clientId === clientId && entry.sub === claims.sub)) {
        return fail(403, { errorDescription: "Principal is not admitted", body: "Forbidden" });
      }
    }
    return allowAuth(identity);
  };
}

/**
 * Validate and snapshot an optional admission policy. Omission preserves the
 * existing authentication contract; explicit [] denies every principal.
 * @param {unknown} value
 * @returns {ReadonlyArray<Readonly<{clientId: string, sub: string}>>|undefined}
 */
function normalizeAllowedPrincipals(value) {
  if (value === undefined) return undefined;
  const invalid = () => new Error("auth.allowedPrincipals must be an array of exact {clientId, sub} pairs");
  if (!Array.isArray(value)) throw invalid();
  const entries = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, "clientId") || !Object.hasOwn(entry, "sub")) throw invalid();
    for (const id of [entry.clientId, entry.sub]) {
      if (typeof id !== "string" || !id || id.trim() !== id || id === "*"
        || /[\u0000-\u001f\u007f]/u.test(id)) throw invalid();
    }
    entries.push(Object.freeze({ clientId: entry.clientId, sub: entry.sub }));
  }
  return Object.freeze(entries);
}

/**
 * Loopback bind hosts. Non-loopback is a network-facing product path.
 *
 * @param {string} bindHost
 * @returns {boolean}
 */
export function isLoopbackBind(bindHost) {
  return bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";
}

/**
 * Named fatal reason when MCP_ALLOW_UNAUTHENTICATED is set on a non-loopback
 * bind (DEV-845). Startup must refuse; there is no trusted-proxy exception
 * beyond loopback.
 */
export const NON_LOOPBACK_UNAUTHENTICATED_REASON =
  "non-loopback bind with MCP_ALLOW_UNAUTHENTICATED is not permitted. " +
  "Bind to 127.0.0.1 or configure an inbound OAuth resource server (auth.issuer and auth.audience).";

/**
 * Named fatal reason when a network bind is missing the single issuer,
 * audience, or RFC 7662 introspection credentials (DEV-844).
 */
export const NETWORK_INTROSPECTION_REQUIRED_REASON =
  "Network-facing HTTPS requires an inbound OAuth resource server with exactly one issuer, " +
  "one audience, and RFC 7662 introspection (auth.issuer, auth.audience, auth.introspectionUrl, " +
  "and introspection client credentials). MCP_AUTH_TOKEN was removed in 4.0.0 (#231). " +
  "MCP_ALLOW_UNAUTHENTICATED is loopback-only. Bind to 127.0.0.1 or configure the resource server.";

/**
 * Complete resource-server config for a network bind (DEV-844).
 *
 * @param {object|null|undefined} resourceServer
 * @returns {boolean}
 */
export function hasCompleteNetworkResourceServer(resourceServer) {
  return Boolean(
    resourceServer?.issuer
    && resourceServer?.audience
    && resourceServer?.introspectionUrl
    && resourceServer?.introspectionClientId
    && resourceServer?.introspectionClientSecret,
  );
}

/**
 * True when any resource-server setting is present. Empty strings from
 * {@link resolveInboundAuthConfig} do not count.
 *
 * @param {object|null|undefined} resourceServer
 * @returns {boolean}
 */
function hasResourceServerIntent(resourceServer) {
  const rs = resourceServer && typeof resourceServer === "object" ? resourceServer : {};
  return Boolean(
    rs.issuer
    || rs.audience
    || rs.introspectionUrl
    || rs.introspectionClientId
    || rs.introspectionClientSecret
    || rs.allowedPrincipals !== undefined,
  );
}

/**
 * Labels for resource-server settings that are still empty.
 *
 * @param {object|null|undefined} resourceServer
 * @returns {string[]}
 */
function missingResourceServerSettings(resourceServer) {
  const rs = resourceServer && typeof resourceServer === "object" ? resourceServer : {};
  const missing = [];
  if (!rs.issuer) missing.push("auth.issuer");
  if (!rs.audience) missing.push("auth.audience");
  if (!rs.introspectionUrl) missing.push("auth.introspectionUrl");
  if (!rs.introspectionClientId) missing.push("introspection client id");
  if (!rs.introspectionClientSecret) missing.push("introspection client secret");
  return missing;
}

/**
 * Startup refusal for a loopback bind whose resource server is incomplete.
 * Names every missing setting.
 *
 * @param {object|null|undefined} resourceServer
 * @returns {string}
 */
function incompleteResourceServerReason(resourceServer) {
  const missing = missingResourceServerSettings(resourceServer);
  return "Loopback bind has an incomplete inbound OAuth resource server. Missing: "
    + missing.join(", ")
    + ". Startup refuses to listen and will not fall through to unauthenticated. "
    + "Configure auth.issuer, auth.audience, and RFC 7662 introspection "
    + "(auth.introspectionUrl plus introspection client id and secret), "
    + "or remove the resource-server settings to run unauthenticated on loopback.";
}

/**
 * Startup refusal when `MCP_AUTH_TOKEN` is set (#231). The shared bearer was
 * removed in 4.0.0; a stale deployment must not keep running while believing
 * the token still gates `/mcp`. Named so callers and tests can match it.
 */
export const SHARED_BEARER_REMOVED_REASON =
  "MCP_AUTH_TOKEN is set, but the loopback shared bearer was removed in 4.0.0 (#231) and is no longer read. " +
  "Unset MCP_AUTH_TOKEN. Configure an inbound OAuth resource server (auth.issuer and auth.audience), " +
  "or run unauthenticated on loopback.";

/**
 * Decide how inbound HTTPS /mcp is authenticated.
 *
 * Network-facing product paths require a resource server with live
 * introspection (DEV-844). Loopback is unauthenticated only when no
 * resource-server config is present. Any issuer, audience, or introspection
 * field with an incomplete set is fatal and does not fall through to
 * unauthenticated.
 * A set `MCP_AUTH_TOKEN` is fatal at any bind host (#231).
 * `MCP_ALLOW_UNAUTHENTICATED` is loopback-only; a non-loopback bind with
 * that flag is fatal (DEV-845).
 *
 * @param {object} options
 * @param {string} options.bindHost
 * @param {boolean} [options.allowUnauth]
 * @param {string} [options.sharedToken] The `MCP_AUTH_TOKEN` value, if any; non-empty is fatal.
 * @param {?object} [options.resourceServer]
 * @returns {{mode: "resource_server"|"unauthenticated"|"fatal", reason?: string}}
 */
export function resolveInboundAuthMode({
  bindHost,
  allowUnauth = false,
  sharedToken = "",
  resourceServer = null,
}) {
  if (sharedToken) return { mode: "fatal", reason: SHARED_BEARER_REMOVED_REASON };
  const isLoopback = isLoopbackBind(bindHost);
  const hasRs = Boolean(resourceServer?.issuer && resourceServer?.audience);
  const ready = networkIntrospectionRequired()
    ? hasCompleteNetworkResourceServer(resourceServer)
    : hasRs;
  if (ready) return { mode: "resource_server" };
  // Any resource-server field means the operator asked for that auth.
  // A loopback bind must not serve /mcp with no authentication when the
  // config is incomplete. Non-loopback keeps its existing fatal reasons.
  // src/index.js passes inboundCfg here via startHttpsTransport and does
  // not choose the mode itself.
  if (isLoopback && hasResourceServerIntent(resourceServer)) {
    return { mode: "fatal", reason: incompleteResourceServerReason(resourceServer) };
  }
  if (allowUnauth && !isLoopback) {
    return { mode: "fatal", reason: NON_LOOPBACK_UNAUTHENTICATED_REASON };
  }
  if (allowUnauth || isLoopback) return { mode: "unauthenticated" };
  return {
    mode: "fatal",
    reason: NETWORK_INTROSPECTION_REQUIRED_REASON,
  };
}

/**
 * Merge config.auth with environment overrides.
 * @param {object} [cfg]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
export function resolveInboundAuthConfig(cfg = {}, env = process.env) {
  const auth = cfg.auth && typeof cfg.auth === "object" ? cfg.auth : {};
  const issuer = env.MCP_RESOURCE_ISSUER || auth.issuer || "";
  const audience = env.MCP_RESOURCE_AUDIENCE || auth.audience || "";
  const resource = env.MCP_RESOURCE || auth.resource || (String(audience).startsWith("https://") ? audience : "");
  const namedId = auth.introspectionClientIdEnv
    ? (env[auth.introspectionClientIdEnv] || "")
    : "";
  const namedSecret = auth.introspectionClientSecretEnv
    ? (env[auth.introspectionClientSecretEnv] || "")
    : "";
  return {
    issuer,
    audience,
    resource,
    requiredScopes: Array.isArray(auth.requiredScopes) ? auth.requiredScopes.map(String) : [],
    allowedPrincipals: normalizeAllowedPrincipals(auth.allowedPrincipals),
    revocationFile: env.MCP_REVOCATION_FILE || auth.revocationFile || "",
    introspectionUrl: env.MCP_INTROSPECTION_URL || auth.introspectionUrl || "",
    introspectionClientIdEnv: auth.introspectionClientIdEnv || "",
    introspectionClientSecretEnv: auth.introspectionClientSecretEnv || "",
    introspectionClientId: env.MCP_INTROSPECTION_CLIENT_ID || namedId || auth.introspectionClientId || "",
    introspectionClientSecret: env.MCP_INTROSPECTION_CLIENT_SECRET || namedSecret || auth.introspectionClientSecret || "",
    introspectionTimeoutMs: normalizeIntrospectionTimeoutMs(
      env.MCP_INTROSPECTION_TIMEOUT_MS || auth.introspectionTimeoutMs,
    ),
    maxTokenLifetime: normalizeMaxTokenLifetime(
      env.MCP_MAX_TOKEN_LIFETIME || auth.maxTokenLifetime || DEFAULT_MAX_TOKEN_LIFETIME,
    ),
    algorithms: normalizeTokenAlgorithms(env.MCP_TOKEN_ALGORITHMS || auth.algorithms),
    // A present env value replaces the configured list, even when empty, so an
    // operator can clear a configured allowlist from the environment.
    allowedOrigins: env.MCP_ALLOWED_ORIGINS !== undefined
      ? String(env.MCP_ALLOWED_ORIGINS).split(/[\s,]+/).filter(Boolean)
      : (Array.isArray(auth.allowedOrigins) ? auth.allowedOrigins.map(String) : []),
    allowedHosts: env.MCP_ALLOWED_HOSTS !== undefined
      ? String(env.MCP_ALLOWED_HOSTS).split(/[\s,]+/).filter(Boolean)
      : (Array.isArray(auth.allowedHosts) ? auth.allowedHosts.map(String) : []),
  };
}

/**
 * Build the live inbound authenticator for HTTPS.
 * @param {object} options
 * @returns {Promise<{
 *   authenticate: Function,
 *   protectedResource: object,
 *   resourceMetadataUrl: string,
 *   revoke?: (jti: string) => {ok: true}|{ok: false, reason: string},
 * }>}
 */
export async function createInboundHttpsAuth({ inboundCfg, fetchFn = fetch }) {
  const allowedPrincipals = normalizeAllowedPrincipals(inboundCfg.allowedPrincipals);
  if (!inboundCfg.issuer || !inboundCfg.audience) {
    throw new Error("createInboundHttpsAuth requires issuer and audience");
  }
  const resource = inboundCfg.resource || inboundCfg.audience;
  if (!isHttpsUrl(resource)) {
    throw new Error("auth.resource (or auth.audience) must be an https URL");
  }
  if (!isHttpsUrl(inboundCfg.issuer)) {
    throw new Error("auth.issuer must be an https URL");
  }
  const creds = resolveIntrospectionCredentials(inboundCfg);
  const requireIntrospection = networkIntrospectionRequired();
  if (requireIntrospection) {
    if (!inboundCfg.introspectionUrl || !creds.clientId || !creds.clientSecret) {
      throw new Error(
        "createInboundHttpsAuth requires RFC 7662 introspection "
        + "(auth.introspectionUrl plus introspection client credentials)",
      );
    }
    if (!isHttpsUrl(inboundCfg.introspectionUrl)) {
      throw new Error("auth.introspectionUrl must be an https URL");
    }
  } else if (inboundCfg.introspectionUrl && !isHttpsUrl(inboundCfg.introspectionUrl)) {
    throw new Error("auth.introspectionUrl must be an https URL");
  }
  const issuer = normalizeIssuer(inboundCfg.issuer);
  const asMeta = await discoverAuthorizationServer(issuer, fetchFn);
  const advertisedIssuer = asMeta.issuer || issuer;
  // JWKS retrieval goes through the same injectable fetch as issuer
  // discovery, with jose's timeoutDuration aligned to the inbound budget.
  const jwks = createRemoteJWKSet(new URL(asMeta.jwks_uri), {
    timeoutDuration: INBOUND_IDP_TIMEOUT_MS,
    [customFetch]: (url, options) => fetchFn(url, withInboundTimeout(options)),
  });
  const resourceMetadataUrl = resourceMetadataUrlFor(resource);
  // The file store backs edge offboard revoke(). Stdio does not build this
  // authenticator, so the file is not a stdio revocation path. Network
  // admission does not consult it when introspection is required (DEV-844).
  const revocationStore = inboundCfg.revocationFile
    ? createRevocationStore({ filePath: inboundCfg.revocationFile })
    : null;

  let introspect;
  if (requireIntrospection || inboundCfg.introspectionUrl) {
    const timeoutMs = normalizeIntrospectionTimeoutMs(inboundCfg.introspectionTimeoutMs);
    introspect = (token) => introspectToken(token, {
      url: inboundCfg.introspectionUrl,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      fetchFn,
      timeoutMs,
    });
  }

  const check = createResourceAuthenticator({
    issuer,
    audience: inboundCfg.audience,
    requiredScopes: inboundCfg.requiredScopes,
    allowedPrincipals,
    resourceMetadataUrl,
    jwks,
    introspect: requireIntrospection ? introspect : undefined,
    revocationStore: requireIntrospection ? null : revocationStore,
    maxTokenLifetime: inboundCfg.maxTokenLifetime,
    algorithms: inboundCfg.algorithms,
    requireIntrospection,
  });

  return {
    authenticate: (req) => check(req.headers.authorization, req.headers),
    protectedResource: protectedResourceMetadata({
      resource,
      authorizationServers: [advertisedIssuer],
      scopesSupported: inboundCfg.requiredScopes,
    }),
    resourceMetadataUrl,
    ...(revocationStore ? {
      revoke: (jti) => revocationStore.revoke({ jti }),
    } : {}),
  };
}

/**
 * Resolve introspection client credentials from the inbound config or env.
 * Secrets are never read from a committed config field name other than an
 * env-var pointer.
 *
 * @param {object} inboundCfg
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{clientId: string, clientSecret: string}}
 */
export function resolveIntrospectionCredentials(inboundCfg = {}, env = process.env) {
  const namedId = inboundCfg.introspectionClientIdEnv
    ? (env[inboundCfg.introspectionClientIdEnv] || "")
    : "";
  const namedSecret = inboundCfg.introspectionClientSecretEnv
    ? (env[inboundCfg.introspectionClientSecretEnv] || "")
    : "";
  return {
    clientId: inboundCfg.introspectionClientId
      || env.MCP_INTROSPECTION_CLIENT_ID
      || namedId
      || "",
    clientSecret: inboundCfg.introspectionClientSecret
      || env.MCP_INTROSPECTION_CLIENT_SECRET
      || namedSecret
      || "",
  };
}
