/**
 * Inbound authentication for the HTTPS MCP transport.
 *
 * Two modes, never mixed on a governed product path:
 *   - Shared bearer (`makeBearerCheck`) — loopback / stdio-adjacent only.
 *   - OAuth resource server (`createResourceAuthenticator`) — network-facing
 *     HTTPS. JWT via issuer discovery + JWKS, optional RFC 7662 introspection,
 *     and a hot-reloaded revocation file. Caller-supplied identity headers
 *     never become the principal.
 */

import { timingSafeEqual } from "crypto";
import { readFileSync, statSync } from "fs";
import { createRemoteJWKSet, jwtVerify } from "jose";

/** Header names that must never become identity. */
export const SPOOFABLE_IDENTITY_HEADERS = Object.freeze([
  "x-mcp-subject",
  "x-mcp-actor",
  "x-mcp-user",
  "x-forwarded-user",
  "x-forwarded-sub",
]);

/**
 * Build a predicate that validates an HTTP Authorization header against an
 * expected bearer token.
 * @param {?string} token Expected token; falsy disables auth (predicate is always true).
 * @returns {(authorizationHeader: any) => boolean} True when the header carries the token.
 */
export function makeBearerCheck(token) {
  if (!token) return () => true; // auth disabled
  const expected = Buffer.from(String(token));
  return (authorizationHeader) => {
    if (typeof authorizationHeader !== "string") return false;
    const prefix = "Bearer ";
    if (!authorizationHeader.startsWith(prefix)) return false;
    const provided = Buffer.from(authorizationHeader.slice(prefix.length));
    // Length check first: timingSafeEqual throws on unequal-length buffers, and
    // the comparison itself stays constant-time to avoid leaking the token.
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };
}

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
 * @returns {Readonly<{sub: ?string, iss: ?string, aud: string|string[]|null, scopes: readonly string[], exp: ?number, nbf: ?number, jti: ?string, clientId: ?string}>}
 */
export function buildIdentity(claims) {
  const scopes = scopesFromClaim(claims.scope ?? claims.scp);
  const aud = claims.aud;
  return Object.freeze({
    sub: claims.sub === undefined || claims.sub === null ? null : String(claims.sub),
    iss: claims.iss === undefined || claims.iss === null ? null : String(claims.iss),
    aud: Array.isArray(aud)
      ? Object.freeze(aud.map(String))
      : (aud === undefined || aud === null ? null : String(aud)),
    scopes: Object.freeze([...scopes]),
    exp: typeof claims.exp === "number" ? claims.exp : null,
    nbf: typeof claims.nbf === "number" ? claims.nbf : null,
    jti: claims.jti === undefined || claims.jti === null ? null : String(claims.jti),
    clientId: (claims.azp === undefined || claims.azp === null)
      && (claims.client_id === undefined || claims.client_id === null)
      ? null
      : String(claims.azp ?? claims.client_id),
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
    headers: {
      "WWW-Authenticate": formatWwwAuthenticate({
        error,
        errorDescription,
        scope,
        resourceMetadata,
      }),
    },
    body: body ?? (status === 403 ? "Forbidden" : "Unauthorized"),
  };
}

/**
 * @param {object} identity
 * @returns {{ok: true, identity: object}}
 */
export function allowAuth(identity) {
  return { ok: true, identity };
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
 * @returns {{isRevoked: (identity: {jti?: ?string, sub?: ?string}) => boolean}}
 */
export function createRevocationStore({
  filePath,
  readFile = readFileSync,
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
      res = await fetchFn(url, { headers: { accept: "application/json" } });
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
 * @param {string} token
 * @param {object} options
 * @returns {Promise<object|null>}
 */
export async function introspectToken(token, {
  url,
  clientId,
  clientSecret,
  fetchFn = fetch,
}) {
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${creds}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({ token }).toString(),
  });
  if (!res.ok) return null;
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
}) {
  const fail = (status, extra) => denyAuth(status, { resourceMetadata: resourceMetadataUrl, ...extra });
  const expectedIssuer = issuer ? normalizeIssuer(issuer) : "";

  async function claimsFromJwt(token) {
    if (verifyJwt) return verifyJwt(token);
    if (!jwks) throw new Error("missing JWKS");
    const { payload } = await jwtVerify(token, jwks, {
      issuer: expectedIssuer ? [expectedIssuer, `${expectedIssuer}/`] : undefined,
      audience,
      clockTolerance,
    });
    return payload;
  }

  return async function authenticate(authorizationHeader, requestHeaders = {}) {
    void requestHeaders;
    const token = parseBearerToken(authorizationHeader);
    if (!token) {
      return fail(401, { error: "invalid_token", errorDescription: "Bearer token required" });
    }

    let claims = null;
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

    if (expectedIssuer && claims.iss && normalizeIssuer(claims.iss) !== expectedIssuer) {
      return fail(401, { error: "invalid_token", errorDescription: "Issuer mismatch" });
    }
    if (audience && !audienceMatches(claims.aud, audience)) {
      return fail(401, { error: "invalid_token", errorDescription: "Audience mismatch" });
    }

    const identity = buildIdentity(claims);
    if (revocationStore?.isRevoked(identity)) {
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
    return allowAuth(identity);
  };
}

/**
 * Decide how inbound HTTPS /mcp is authenticated.
 *
 * Network-facing product paths require a resource server. MCP_AUTH_TOKEN is
 * accepted only on loopback (or when the operator has opted into an unauthenticated
 * trusted-proxy front).
 *
 * @param {object} options
 * @returns {{mode: "resource_server"|"shared_bearer"|"unauthenticated"|"fatal", reason?: string}}
 */
export function resolveInboundAuthMode({
  bindHost,
  allowUnauth = false,
  sharedToken = "",
  resourceServer = null,
}) {
  const isLoopback = bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";
  const hasRs = Boolean(resourceServer?.issuer && resourceServer?.audience);
  if (hasRs) return { mode: "resource_server" };
  if (allowUnauth) return { mode: "unauthenticated" };
  if (isLoopback) {
    return sharedToken ? { mode: "shared_bearer" } : { mode: "unauthenticated" };
  }
  return {
    mode: "fatal",
    reason:
      "Network-facing HTTPS requires an inbound OAuth resource server (auth.issuer and auth.audience). " +
      "MCP_AUTH_TOKEN is not accepted on governed product paths. " +
      "Bind to 127.0.0.1, set MCP_ALLOW_UNAUTHENTICATED=1 behind a trusted proxy, or configure the resource server.",
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
  return {
    issuer,
    audience,
    resource,
    requiredScopes: Array.isArray(auth.requiredScopes) ? auth.requiredScopes.map(String) : [],
    revocationFile: env.MCP_REVOCATION_FILE || auth.revocationFile || "",
    introspectionUrl: env.MCP_INTROSPECTION_URL || auth.introspectionUrl || "",
    introspectionClientIdEnv: auth.introspectionClientIdEnv || "",
    introspectionClientSecretEnv: auth.introspectionClientSecretEnv || "",
  };
}

/**
 * Build the live inbound authenticator for HTTPS.
 * @param {object} options
 * @returns {Promise<{authenticate: Function, protectedResource: object, resourceMetadataUrl: string}>}
 */
export async function createInboundHttpsAuth({ inboundCfg, fetchFn = fetch }) {
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
  if (inboundCfg.introspectionUrl && !isHttpsUrl(inboundCfg.introspectionUrl)) {
    throw new Error("auth.introspectionUrl must be an https URL");
  }
  const issuer = normalizeIssuer(inboundCfg.issuer);
  const asMeta = await discoverAuthorizationServer(issuer, fetchFn);
  const advertisedIssuer = asMeta.issuer || issuer;
  const jwks = createRemoteJWKSet(new URL(asMeta.jwks_uri));
  const resourceMetadataUrl = resourceMetadataUrlFor(resource);
  const revocationStore = inboundCfg.revocationFile
    ? createRevocationStore({ filePath: inboundCfg.revocationFile })
    : null;

  let introspect;
  if (inboundCfg.introspectionUrl) {
    const env = new Map(Object.entries(process.env));
    const idKey = inboundCfg.introspectionClientIdEnv;
    const secretKey = inboundCfg.introspectionClientSecretEnv;
    introspect = (token) => introspectToken(token, {
      url: inboundCfg.introspectionUrl,
      clientId: idKey ? env.get(idKey) || "" : "",
      clientSecret: secretKey ? env.get(secretKey) || "" : "",
      fetchFn,
    });
  }

  const check = createResourceAuthenticator({
    issuer,
    audience: inboundCfg.audience,
    requiredScopes: inboundCfg.requiredScopes,
    resourceMetadataUrl,
    jwks,
    introspect,
    revocationStore,
  });

  return {
    authenticate: (req) => check(req.headers.authorization, req.headers),
    protectedResource: protectedResourceMetadata({
      resource,
      authorizationServers: [advertisedIssuer],
      scopesSupported: inboundCfg.requiredScopes,
    }),
    resourceMetadataUrl,
  };
}
