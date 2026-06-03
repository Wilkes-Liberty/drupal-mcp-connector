/**
 * OAuth2 token manager for the client_credentials grant against Drupal
 * simple_oauth.
 *
 * Security notes:
 *   - The client secret is read from the resolved site config (sourced from an
 *     env var, see resolveOauth). It is sent only in the token request body and
 *     is never logged or included in thrown errors.
 *   - Tokens are cached in memory per site and silently re-acquired before
 *     expiry (60s skew) or when forcibly cleared on a 401.
 */

import fetch from "node-fetch";

/** Re-acquire this many ms before the stated expiry to absorb clock skew. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Per-site token cache, keyed by site._name. A value is either a resolved
 * { token, expiresAt, refreshToken } entry or an in-flight Promise of one
 * (so concurrent acquires share a single token request).
 */
const cache = new Map();

/**
 * Error thrown when the token endpoint returns a non-2xx response.
 * Carries the HTTP status but never the client secret.
 */
export class OAuthError extends Error {
  /**
   * @param {string} message Human-readable error (never includes the secret).
   * @param {number} [status] HTTP status from the token endpoint, if any.
   */
  constructor(message, status) {
    super(message);
    this.name = "OAuthError";
    this.status = status;
  }
}

/**
 * Build the url-encoded token request body for either grant.
 * @param {object} oauth Resolved oauth block (clientId, clientSecret, grant, scopes).
 * @param {boolean} useRefresh Use the refresh_token grant instead of the base grant.
 * @param {?string} refreshToken Refresh token to send when useRefresh is true.
 * @returns {string} application/x-www-form-urlencoded body.
 */
function buildBody(oauth, useRefresh, refreshToken) {
  const params = new URLSearchParams();
  if (useRefresh) {
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refreshToken);
  } else {
    params.set("grant_type", oauth.grant || "client_credentials");
  }
  params.set("client_id", oauth.clientId);
  params.set("client_secret", oauth.clientSecret);
  if (Array.isArray(oauth.scopes) && oauth.scopes.length > 0) {
    params.set("scope", oauth.scopes.join(" "));
  }
  return params.toString();
}

/**
 * Perform a single token-endpoint request and normalize the response.
 * @param {object} site Resolved site config with an oauth block.
 * @param {boolean} useRefresh Whether to use the refresh_token grant.
 * @param {?string} refreshToken Refresh token for the refresh grant.
 * @returns {Promise<{token: string, expiresAt: number, refreshToken: ?string}>}
 * @throws {OAuthError} on a non-2xx response or a missing access_token.
 */
async function requestToken(site, useRefresh, refreshToken) {
  const { oauth } = site;
  const url = `${site.baseUrl}${oauth.tokenUrl || "/oauth/token"}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: buildBody(oauth, useRefresh, refreshToken),
  });

  if (!res.ok) {
    throw new OAuthError(
      `OAuth token request to ${site._name} failed with status ${res.status}.`,
      res.status
    );
  }

  const data = await res.json();
  if (!data.access_token || typeof data.access_token !== "string") {
    throw new OAuthError(
      `OAuth token response from ${site._name} is missing access_token.`,
      res.status
    );
  }
  const expiresIn = Number(data.expires_in) || 0;
  return {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    refreshToken: data.refresh_token || null,
  };
}

/**
 * Acquire a token, attempting the refresh grant when a refresh token is cached.
 * If the refresh grant fails (revoked/expired), fall back once to a fresh
 * client_credentials grant; only surface the error if that also fails.
 * @param {object} site Resolved site config with an oauth block.
 * @param {boolean} useRefresh Attempt the refresh grant first.
 * @param {?string} refreshToken Refresh token for the refresh grant.
 * @returns {Promise<{token: string, expiresAt: number, refreshToken: ?string}>}
 * @throws {OAuthError} if the base grant fails.
 */
async function acquireToken(site, useRefresh, refreshToken) {
  if (!useRefresh) {
    return requestToken(site, false, null);
  }
  try {
    return await requestToken(site, true, refreshToken);
  } catch {
    return requestToken(site, false, null);
  }
}

/**
 * Return a valid access token for the site, acquiring or refreshing as needed.
 * Concurrent callers share a single in-flight token request via the cache.
 * @param {object} site Resolved site config with an oauth block.
 * @returns {Promise<string>} A non-expired access token.
 * @throws {OAuthError} if a token cannot be acquired.
 */
export async function getAccessToken(site) {
  const key = site._name;
  const cached = cache.get(key);

  // A cached entry may be a resolved token object or an in-flight Promise from a
  // concurrent acquire; normalize before reading its fields.
  if (cached) {
    const resolved = await Promise.resolve(cached);
    if (Date.now() < resolved.expiresAt - EXPIRY_SKEW_MS) {
      return resolved.token;
    }
  }

  const useRefresh = Boolean(cached && !(cached instanceof Promise) && cached.refreshToken);
  const refreshToken = useRefresh ? cached.refreshToken : null;

  // Store the in-flight Promise before awaiting so concurrent callers share one
  // request. Replace with the resolved entry on success; clear on failure so a
  // transient error does not poison the cache.
  const pending = acquireToken(site, useRefresh, refreshToken)
    .then((entry) => {
      cache.set(key, entry);
      return entry;
    })
    .catch((err) => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, pending);

  const entry = await pending;
  return entry.token;
}

/**
 * Drop any cached token for the site, forcing a fresh acquire on the next call.
 * Used by the 401 retry path.
 * @param {object} site Resolved site config (keyed by site._name).
 * @returns {void}
 */
export function clearToken(site) {
  cache.delete(site._name);
}
