/** Local browser authorization. Credentials never leave this process's memory. */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { createLocalJWKSet, jwtVerify } from "jose";

const sessions = new Map();
const configurationError = () => new Error("Invalid browser sign-in configuration.");
const loginError = () => new Error("Browser sign-in failed. Start a new sign-in session.");

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw configurationError();
  return url;
}

/** Validate issuer, resource, scopes and the exact IPv4 loopback redirect. */
export function validatePkceConfig(config) {
  try {
    httpsUrl(config.issuer);
    httpsUrl(config.resource);
    if (config.audience !== undefined && (typeof config.audience !== "string" || !config.audience.trim() || /\s/.test(config.audience))) throw configurationError();
    const callback = new URL(config.redirectUri);
    if (callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" || !callback.port || Number(callback.port) < 1 || callback.username || callback.password || callback.search || callback.hash) throw configurationError();
    if (typeof config.clientId !== "string" || !config.clientId.trim() || !Array.isArray(config.scopes) || !config.scopes.length || config.scopes.some(scope => typeof scope !== "string" || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) throw configurationError();
  } catch { throw configurationError(); }
}

function key(site) {
  validatePkceConfig(site.pkce);
  return JSON.stringify([site._name, site.pkce]);
}

/** Install a verified access token for this exact site configuration. */
export function installPkceSession(site, entry) {
  sessions.set(key(site), { token: entry.token, expiresAt: entry.expiresAt });
}

/** Return a current session, or refuse without consulting other credentials. */
export function getPkceToken(site) {
  const id = key(site);
  const entry = sessions.get(id);
  if (!entry || entry.expiresAt <= Date.now() + 30000) {
    sessions.delete(id);
    throw new Error("Browser sign-in required. Restart with drupal-mcp-login.");
  }
  return entry.token;
}

function equalState(actual, expected) {
  const a = Buffer.from(actual || "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Authorize once with S256, validate the signed access token and close the listener. */
export async function authorizePkce(config, { fetcher = globalThis.fetch, openBrowser, timeoutMs = 300000 } = {}) {
  validatePkceConfig(config);
  let server;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const readJson = async (url, options = {}) => {
      const response = await fetcher(url, { ...options, redirect: "error", signal: controller.signal });
      if (!response.ok) throw loginError();
      const body = await response.text();
      if (body.length > 1024 * 1024) throw loginError();
      return JSON.parse(body);
    };
    const metadata = await readJson(`${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (metadata.issuer !== config.issuer || !metadata.code_challenge_methods_supported?.includes("S256")) throw loginError();
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
      if (httpsUrl(endpoint).origin !== new URL(config.issuer).origin) throw loginError();
    }
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const redirect = new URL(config.redirectUri);
    let receive;
    let refuse;
    const callback = new Promise((resolve, reject) => { receive = resolve; refuse = reject; });
    // Observe failures immediately, including while the browser launcher is pending.
    callback.catch(() => {});
    controller.signal.addEventListener("abort", () => refuse(loginError()), { once: true });
    if (controller.signal.aborted) throw loginError();
    let used = false;
    server = http.createServer((request, response) => {
      let url;
      try { url = new URL(request.url, redirect.origin); }
      catch {
        response.writeHead(400).end();
        return;
      }
      if (request.method !== "GET" || request.headers.host !== redirect.host || url.origin !== redirect.origin || url.pathname !== redirect.pathname || used) {
        response.writeHead(404).end();
        return;
      }
      used = true;
      const valid = ["code", "state"].every(name => url.searchParams.getAll(name).length === 1 && url.searchParams.get(name)) &&
        !url.searchParams.has("error") && equalState(url.searchParams.get("state"), state) &&
        url.searchParams.getAll("iss").length <= 1 &&
        (metadata.authorization_response_iss_parameter_supported ? url.searchParams.get("iss") === config.issuer : !url.searchParams.has("iss") || url.searchParams.get("iss") === config.issuer);
      response.writeHead(valid ? 200 : 400, { "Content-Type": "text/plain", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer" }).end(valid ? "Sign-in received. Return to your application." : "Sign-in refused. Start again.");
      if (valid) receive(url.searchParams.get("code"));
      else refuse(loginError());
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(redirect.port), "127.0.0.1", resolve);
    });
    const authorization = new URL(metadata.authorization_endpoint);
    authorization.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scopes.join(" "), resource: config.resource, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
    const launch = Promise.resolve().then(() => openBrowser(authorization.href));
    await Promise.race([launch, callback.then(() => undefined)]);
    const code = await callback;
    const result = await readJson(metadata.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, redirect_uri: config.redirectUri, code, code_verifier: verifier, resource: config.resource }).toString() });
    if (result.token_type?.toLowerCase() !== "bearer" || typeof result.access_token !== "string") throw loginError();
    const jwks = await readJson(metadata.jwks_uri);
    const { payload } = await jwtVerify(result.access_token, createLocalJWKSet(jwks), { issuer: config.issuer, audience: config.audience ?? config.resource, algorithms: ["RS256", "PS256", "ES256"], requiredClaims: ["sub", "tenant", "azp", "exp", "iat"] });
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const scopes = Array.isArray(payload.scope) ? payload.scope : typeof payload.scope === "string" ? payload.scope.split(" ") : [];
    if (audiences.length !== 1 || audiences[0] !== (config.audience ?? config.resource) || typeof payload.sub !== "string" || !payload.sub.trim() || typeof payload.tenant !== "string" || !payload.tenant.trim() || payload.azp !== config.clientId || (payload.client_id !== undefined && payload.client_id !== config.clientId) || !config.scopes.every(scope => scopes.includes(scope))) throw loginError();
    if (!Number.isFinite(result.expires_in) || result.expires_in <= 30) throw loginError();
    const expiresAt = Math.min(payload.exp * 1000, Date.now() + result.expires_in * 1000);
    if (expiresAt <= Date.now() + 30000) throw loginError();
    return { token: result.access_token, expiresAt };
  } catch { throw loginError(); }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}
