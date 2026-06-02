import { describe, it, expect, afterEach } from "vitest";
import { clientHeaders, CLIENT_VERSION, resolveApiToken, assertSecureAuth } from "../../src/lib/config.js";
import { SecurityError } from "../../src/lib/security.js";

const ORIG = process.env.MCP_CLIENT_ID;
afterEach(() => { if (ORIG === undefined) delete process.env.MCP_CLIENT_ID; else process.env.MCP_CLIENT_ID = ORIG; });

describe("clientHeaders", () => {
  it("defaults to drupal-mcp-server/<version> on both headers", () => {
    delete process.env.MCP_CLIENT_ID;
    const h = clientHeaders();
    expect(h["X-MCP-Client"]).toBe(`drupal-mcp-server/${CLIENT_VERSION}`);
    expect(h["User-Agent"]).toBe(`drupal-mcp-server/${CLIENT_VERSION}`);
  });
  it("honors a custom MCP_CLIENT_ID", () => {
    process.env.MCP_CLIENT_ID = "acme-bot/9.9";
    expect(clientHeaders()["X-MCP-Client"]).toBe("acme-bot/9.9");
  });
  it("can be disabled with an empty MCP_CLIENT_ID", () => {
    process.env.MCP_CLIENT_ID = "";
    expect(clientHeaders()).toEqual({});
  });
});

describe("resolveApiToken", () => {
  it("fills apiToken from the named env var when absent", () => {
    process.env.MY_TOK = "from-env";
    const s = resolveApiToken({ _name: "t", baseUrl: "https://x", apiTokenEnv: "MY_TOK" });
    expect(s.apiToken).toBe("from-env");
    delete process.env.MY_TOK;
  });
  it("leaves an explicit apiToken untouched", () => {
    const s = resolveApiToken({ _name: "t", baseUrl: "https://x", apiToken: "explicit", apiTokenEnv: "MY_TOK" });
    expect(s.apiToken).toBe("explicit");
  });
  it("is a no-op when neither is set", () => {
    const s = resolveApiToken({ _name: "t", baseUrl: "https://x" });
    expect(s.apiToken).toBeUndefined();
  });
});

describe("assertSecureAuth", () => {
  it("does nothing when requireSecureAuth is unset", () => {
    expect(() => assertSecureAuth({ baseUrl: "http://x", username: "a", password: "b" })).not.toThrow();
  });
  it("requires HTTPS when enabled", () => {
    expect(() => assertSecureAuth({ requireSecureAuth: true, baseUrl: "http://x", apiToken: "t" })).toThrow(SecurityError);
  });
  it("requires a Bearer token (rejects anon/basic) when enabled", () => {
    expect(() => assertSecureAuth({ requireSecureAuth: true, baseUrl: "https://x", username: "a", password: "b" })).toThrow(SecurityError);
    expect(() => assertSecureAuth({ requireSecureAuth: true, baseUrl: "https://x" })).toThrow(SecurityError);
  });
  it("passes with HTTPS + Bearer", () => {
    expect(() => assertSecureAuth({ requireSecureAuth: true, baseUrl: "https://x", apiToken: "t" })).not.toThrow();
  });
});
