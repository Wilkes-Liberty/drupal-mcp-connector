// Failure modes: credentials falling back when sign-in is absent, stale sessions,
// hosted reuse, and a static credential winning over the principal's token.
import { describe, expect, it } from "vitest";
import { authHeaders, authHeadersAsync, assertSecureAuth } from "../../src/lib/config.js";
import { installPkceSession } from "../../src/lib/pkce-login.js";
import { assertLocalPkce } from "../../src/lib/pkce-cli.js";
const pkce = { issuer: "https://identity.example/realms/demo", resource: "https://cms.example/mcp", clientId: "cli", scopes: ["mcp_read"], redirectUri: "http://127.0.0.1:8765/callback" };
describe("PKCE credential routing", () => {
  it("requires sign-in on both synchronous and asynchronous paths", async () => {
    const site = { _name: "unsigned", pkce };
    expect(() => authHeaders(site)).toThrow(/sign.in/i);
    await expect(authHeadersAsync(site)).rejects.toThrow(/sign.in/i);
  });
  it("uses only the signed-in principal credential", async () => {
    const site = { _name: "signed", baseUrl: "https://cms.example", requireSecureAuth: true, pkce };
    expect(() => assertSecureAuth(site)).not.toThrow();
    installPkceSession(site, { token: "synthetic-access-token", expiresAt: Date.now() + 300000 });
    expect(authHeaders(site)).toEqual({ Authorization: "Bearer synthetic-access-token" });
    expect(await authHeadersAsync(site)).toEqual(authHeaders(site));
  });
  it.each(["oauth", "apiToken", "apiTokenEnv", "username", "password"])("refuses ambiguous %s credentials", async (field) => {
    const site = { _name: "ambiguous", pkce, [field]: "unused" };
    expect(() => authHeaders(site)).toThrow(/configuration/i);
    await expect(authHeadersAsync(site)).rejects.toThrow(/configuration/i);
  });
  it.each(["https", "http", "unknown"])("refuses browser sessions on %s transport", (transport) => {
    expect(() => assertLocalPkce({ sites: { content: { pkce } } }, transport)).toThrow(/stdio/i);
  });
  it("allows the explicit local path and leaves other auth modes alone", () => {
    expect(() => assertLocalPkce({ sites: { content: { pkce } } }, "stdio")).not.toThrow();
    expect(() => assertLocalPkce({ sites: { content: { oauth: {} } } }, "https")).not.toThrow();
  });
});
