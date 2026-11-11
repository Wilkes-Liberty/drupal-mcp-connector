import { createHash } from "node:crypto";
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { authorizePkce, installPkceSession, getPkceToken, validatePkceConfig } from "../../src/lib/pkce-login.js";

// Failure modes: code interception/state mix-up, callback replay, untrusted
// discovery/keys, wrong resource or principal, expired credentials, browser or
// issuer outage, token leakage, and silent shared-credential fallback.
const issuer = "https://identity.example/realms/demo";
const resource = "https://cms.example/mcp";
let privateKey;
let jwk;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: "login-key", alg: "RS256" };
});
async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
  });
}
async function fixture(options = {}) {
  const redirectUri = `http://127.0.0.1:${await freePort()}/callback`;
  const config = { issuer, resource, clientId: "content-cli", scopes: ["mcp_read"], redirectUri };
  let authorization;
  let exchanged = 0;
  let token;
  const fetcher = vi.fn(async (url, init) => {
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({ issuer: options.discoveryIssuer ?? issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: options.jwksUri ?? `${issuer}/certs`, code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true });
    }
    if (url === `${issuer}/certs`) return Response.json({ keys: [jwk] });
    if (url !== `${issuer}/token`) throw new Error("Unexpected endpoint");
    exchanged++;
    const form = new URLSearchParams(init.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.has("client_secret")).toBe(false);
    expect(form.get("redirect_uri")).toBe(redirectUri);
    expect(form.get("resource")).toBe(resource);
    expect(createHash("sha256").update(form.get("code_verifier")).digest("base64url")).toBe(authorization.searchParams.get("code_challenge"));
    const claims = { sub: "operator-subject", tenant: "tenant-one", azp: "content-cli", scope: "mcp_read", ...options.claims };
    token = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "login-key" }).setIssuer(options.tokenIssuer ?? issuer).setAudience(options.audience ?? resource).setIssuedAt().setExpirationTime(options.expiry ?? "5m").sign(privateKey);
    return Response.json({ access_token: token, token_type: "Bearer", expires_in: 300, refresh_token: "must-not-be-retained" });
  });
  const openBrowser = async (url) => {
    authorization = new URL(url);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("resource")).toBe(resource);
    expect(authorization.searchParams.get("client_id")).toBe("content-cli");
    expect(authorization.searchParams.get("scope")).toBe("mcp_read");
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", "one-time-code");
    callback.searchParams.set("state", options.wrongState ? "forged-state" : authorization.searchParams.get("state"));
    callback.searchParams.set("iss", options.callbackIssuer ?? issuer);
    if (options.duplicateCode) callback.searchParams.append("code", "second-code");
    if (options.noCallback) return;
    await get(callback);
  };
  return { config, fetcher, openBrowser, exchanges: () => exchanged, token: () => token };
}
describe("explicit local PKCE sign-in", () => {
  it("exchanges a loopback code using S256 and retains only the verified access token", async () => {
    const f = await fixture();
    const entry = await authorizePkce(f.config, { fetcher: f.fetcher, openBrowser: f.openBrowser });
    expect(entry.token).toBe(f.token());
    expect(entry.refreshToken).toBeUndefined();
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
    expect(f.exchanges()).toBe(1);
    await expect(get(f.config.redirectUri)).rejects.toThrow();
    const site = { _name: "content", pkce: f.config };
    installPkceSession(site, entry);
    expect(getPkceToken(site)).toBe(entry.token);
    expect(() => getPkceToken({ ...site, _name: "another" })).toThrow(/sign.in/i);
    expect(() => getPkceToken({ ...site, pkce: { ...f.config, resource: "https://other.example/mcp" } })).toThrow(/sign.in/i);
  });
  it.each([
    ["wrong state", { wrongState: true }],
    ["callback issuer", { callbackIssuer: "https://other.example" }],
    ["ambiguous code", { duplicateCode: true }],
    ["discovery issuer", { discoveryIssuer: "https://other.example" }],
    ["foreign keys", { jwksUri: "https://other.example/keys" }],
    ["token issuer", { tokenIssuer: "https://other.example" }],
    ["wrong audience", { audience: "https://other.example/mcp" }],
    ["extra audience", { audience: [resource, "other"] }],
    ["missing subject", { claims: { sub: "" } }],
    ["missing tenant", { claims: { tenant: "" } }],
    ["wrong client", { claims: { azp: "other-client" } }],
    ["missing exact scope", { claims: { scope: "mcp_write" } }],
    ["expiry", { expiry: "-1s" }],
  ])("refuses %s without leaking the code or token", async (_name, options) => {
    const f = await fixture(options);
    await expect(authorizePkce(f.config, { fetcher: f.fetcher, openBrowser: f.openBrowser })).rejects.toThrow(/sign.in|configuration/i);
    try { await authorizePkce(f.config, { fetcher: f.fetcher, openBrowser: async () => { throw new Error("one-time-code sensitive-token"); } }); }
    catch (error) { expect(error.message).not.toMatch(/one-time-code|sensitive-token/); }
  });
  it("validates the existing CMS audience separately from the OAuth resource URI", async () => {
    const f = await fixture({ audience: "cms-agent" });
    f.config.audience = "cms-agent";
    const entry = await authorizePkce(f.config, { fetcher: f.fetcher, openBrowser: f.openBrowser });
    expect(entry.token).toBe(f.token());
  });
  it("times out and closes its loopback listener", async () => {
    const f = await fixture({ noCallback: true });
    await expect(authorizePkce(f.config, { fetcher: f.fetcher, openBrowser: f.openBrowser, timeoutMs: 30 })).rejects.toThrow(/sign.in/i);
    await expect(get(f.config.redirectUri)).rejects.toThrow();
    expect(f.exchanges()).toBe(0);
  });
  it("never returns an expired session or substitutes an oauth credential", () => {
    const pkce = { issuer, resource, clientId: "cli", scopes: ["mcp_read"], redirectUri: "http://127.0.0.1:8765/callback" };
    const site = { _name: "expired", pkce, oauth: { clientSecret: "not-a-fallback" } };
    installPkceSession(site, { token: "expired-token", expiresAt: Date.now() - 1 });
    expect(() => getPkceToken(site)).toThrow(/sign.in/i);
  });
  it.each([
    { issuer: "http://identity.example" },
    { redirectUri: "http://localhost:8765/callback" },
    { redirectUri: "http://0.0.0.0:8765/callback" },
    { redirectUri: "http://127.0.0.1:0/callback" },
    { redirectUri: "http://127.0.0.1:8765/callback?code=bad" },
    { scopes: [] },
  ])("rejects unsafe configuration before network or browser use: %o", (override) => {
    expect(() => validatePkceConfig({ issuer, resource, clientId: "cli", scopes: ["mcp_read"], redirectUri: "http://127.0.0.1:8765/callback", ...override })).toThrow(/configuration/i);
  });
});
