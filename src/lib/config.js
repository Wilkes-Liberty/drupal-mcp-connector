/**
 * Config loading, site resolution, and auth header generation.
 *
 * Security notes:
 *   - Credentials are loaded once, cached in memory, never logged.
 *   - validateBaseUrl() enforces HTTPS for non-localhost connections.
 *   - All exported functions are pure — no side effects beyond the cache.
 */

import { readFileSync }                  from "fs";
import { resolve }                       from "path";
import { validateBaseUrl }               from "./validate.js";
import { SecurityError }                 from "./security.js";

/** Connector version for the X-MCP-Client identity label. Keep in sync with package.json. */
export const CLIENT_VERSION = "0.4.0";

/**
 * Identity headers sent on every outbound Drupal request. Lets governance layers
 * (e.g. mcp_sentinel) label/identify connector traffic. ON by default; set
 * MCP_CLIENT_ID to override the value, or to "" to disable entirely.
 */
export function clientHeaders() {
  const id = process.env.MCP_CLIENT_ID ?? `drupal-mcp-server/${CLIENT_VERSION}`;
  if (!id) return {};
  return { "X-MCP-Client": id, "User-Agent": id };
}

/**
 * If a site declares apiTokenEnv and has no explicit apiToken, source the token
 * from that environment variable (keeps secrets out of the config file).
 */
export function resolveApiToken(site) {
  if (site.apiToken || !site.apiTokenEnv) return site;
  const fromEnv = new Map(Object.entries(process.env)).get(site.apiTokenEnv) || "";
  return { ...site, apiToken: fromEnv };
}

/**
 * If a site declares an oauth block, source the client secret from the named
 * env var when no explicit clientSecret is set, and apply defaults for tokenUrl
 * and grant. Keeps the secret out of the config file.
 */
export function resolveOauth(site) {
  if (!site.oauth) return site;
  const oauth = { ...site.oauth };
  if (!oauth.clientSecret && oauth.clientSecretEnv) {
    oauth.clientSecret = new Map(Object.entries(process.env)).get(oauth.clientSecretEnv) || "";
  }
  oauth.tokenUrl = oauth.tokenUrl || "/oauth/token";
  oauth.grant = oauth.grant || "client_credentials";
  return { ...site, oauth };
}

/**
 * Whether a site has a usable OAuth2 client-credentials block (clientId plus a
 * resolved clientSecret). Used to satisfy the strong-auth requirement.
 */
function hasValidOauth(site) {
  return Boolean(site.oauth?.clientId && site.oauth?.clientSecret);
}

/**
 * Opt-in strong-auth enforcement. When site.requireSecureAuth is true, the site
 * must use HTTPS and either a Bearer apiToken or a valid OAuth2 client-credentials
 * block — anonymous and basic auth are rejected.
 */
export function assertSecureAuth(site) {
  if (!site.requireSecureAuth) return;
  if (!String(site.baseUrl || "").startsWith("https://")) {
    throw new SecurityError(`Site "${site._name}": requireSecureAuth is set but baseUrl is not HTTPS.`);
  }
  if (!site.apiToken && !hasValidOauth(site)) {
    throw new SecurityError(
      `Site "${site._name}": requireSecureAuth is set but no Bearer apiToken or OAuth2 client ` +
      "credentials are configured (anonymous and basic auth are not permitted). " +
      "Provide apiToken/apiTokenEnv or an oauth block."
    );
  }
}

let _config = null;

// ---------------------------------------------------------------------------
// Load + validate config
// ---------------------------------------------------------------------------

export function loadConfig() {
  if (_config) return _config;

  // Config file takes priority; env vars are the single-site fallback.
  try {
    const configPath = resolve(process.cwd(), "config", "config.json");
    _config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    _config = {
      defaultSite: "default",
      sites: {
        default: {
          baseUrl:         process.env.DRUPAL_BASE_URL      || "",
          apiToken:        process.env.DRUPAL_API_TOKEN     || "",
          username:        process.env.DRUPAL_USERNAME       || "",
          password:        process.env.DRUPAL_PASSWORD       || "",
          graphqlEndpoint: process.env.DRUPAL_GRAPHQL_ENDPOINT || "/graphql",
        },
      },
    };
  }

  validateConfig(_config);
  return _config;
}

function validateConfig(cfg) {
  if (!cfg.sites || typeof cfg.sites !== "object") {
    throw new Error("Config error: 'sites' must be an object.");
  }

  for (const [name, site] of Object.entries(cfg.sites)) {
    if (!site.baseUrl) {
      throw new Error(`Config error: site "${name}" is missing "baseUrl".`);
    }

    // Enforce HTTPS for non-localhost — throws SecurityError for plain HTTP
    site.baseUrl = validateBaseUrl(site.baseUrl, name);

    if (!site.apiToken && !(site.username && site.password)) {
      console.warn(
        `[drupal-mcp-server] Warning: site "${name}" has no apiToken or username/password. ` +
        "Unauthenticated requests will be limited to public content."
      );
    }

    if (site.apiToken && site.username) {
      console.warn(
        `[drupal-mcp-server] Warning: site "${name}" has both apiToken and username set. ` +
        "apiToken takes priority. Remove the unused credential."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Site resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a named site config, falling back to the default.
 * @param {string|undefined} siteName
 * @returns {object} Site config with _name injected.
 * @throws if the site name is unknown.
 */
export function getSiteConfig(siteName) {
  const cfg  = loadConfig();
  const name = siteName || cfg.defaultSite;
  const site = new Map(Object.entries(cfg.sites)).get(name);

  if (!site) {
    const available = Object.keys(cfg.sites).join(", ");
    throw new Error(`Unknown site: "${name}". Configured sites: ${available}`);
  }

  const resolved = resolveOauth(resolveApiToken({ ...site, _name: name }));
  assertSecureAuth(resolved);
  return resolved;
}

export function listSiteNames() {
  return Object.keys(loadConfig().sites);
}

// ---------------------------------------------------------------------------
// Auth headers — never logged, never exposed in tool responses
// ---------------------------------------------------------------------------

/**
 * Build the Authorization header for a site.
 * Bearer token takes priority over Basic auth.
 * @param {object} site
 * @returns {object} Headers object
 */
export function authHeaders(site) {
  if (site.apiToken) {
    return { Authorization: `Bearer ${site.apiToken}` };
  }
  if (site.username && site.password) {
    const creds = Buffer.from(`${site.username}:${site.password}`).toString("base64");
    return { Authorization: `Basic ${creds}` };
  }
  return {};
}

// ---------------------------------------------------------------------------
// TLS config (for HTTP transport mode)
// ---------------------------------------------------------------------------

/**
 * Returns TLS cert + key paths from config or environment variables.
 * Used by the HTTP transport to set up HTTPS.
 */
export function getTlsConfig() {
  const cfg = loadConfig();
  return {
    certPath: cfg.tls?.certPath || process.env.TLS_CERT_PATH || null,
    keyPath:  cfg.tls?.keyPath  || process.env.TLS_KEY_PATH  || null,
    port:     Number(cfg.tls?.port || process.env.MCP_PORT || 3443),
  };
}
