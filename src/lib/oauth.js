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

/** Per-site token cache, keyed by site._name → { token, expiresAt, refreshToken }. */
const cache = new Map();

/**
 * Error thrown when the token endpoint returns a non-2xx response.
 * Carries the HTTP status but never the client secret.
 */
export class OAuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OAuthError";
    this.status = status;
  }
}

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
  const expiresIn = Number(data.expires_in) || 0;
  return {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    refreshToken: data.refresh_token || null,
  };
}

/**
 * Return a valid access token for the site, acquiring or refreshing as needed.
 * @param {object} site Resolved site config with an oauth block.
 * @returns {Promise<string>}
 */
export async function getAccessToken(site) {
  const key = site._name;
  const cached = cache.get(key);

  if (cached && Date.now() < cached.expiresAt - EXPIRY_SKEW_MS) {
    return cached.token;
  }

  const useRefresh = Boolean(cached?.refreshToken);
  const entry = await requestToken(site, useRefresh, cached?.refreshToken);
  cache.set(key, entry);
  return entry.token;
}

/**
 * Drop any cached token for the site, forcing a fresh acquire on the next call.
 * Used by the 401 retry path.
 */
export function clearToken(site) {
  cache.delete(site._name);
}
