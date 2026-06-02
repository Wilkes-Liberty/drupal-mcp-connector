import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("node-fetch", () => ({ default: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) }));
import fetch from "node-fetch";
import { drupalFetch } from "../../src/lib/drupal-fetch.js";
import { CLIENT_VERSION } from "../../src/lib/config.js";
import { clearToken } from "../../src/lib/oauth.js";

const ok = () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
const oauthSite = (name) => ({
  _name: name,
  baseUrl: "https://x",
  oauth: { tokenUrl: "/oauth/token", clientId: "c", clientSecret: "s", grant: "client_credentials", scopes: ["mcp:read"] },
});

beforeEach(() => { vi.mocked(fetch).mockReset(); vi.mocked(fetch).mockImplementation(async () => ok()); delete process.env.MCP_CLIENT_ID; });

describe("drupalFetch identity header", () => {
  it("sends X-MCP-Client + User-Agent on requests", async () => {
    await drupalFetch({ _name: "t", baseUrl: "https://x" }, "/jsonapi/node/article");
    const opts = vi.mocked(fetch).mock.calls[0][1];
    const expected = `drupal-mcp-server/${CLIENT_VERSION}`;
    expect(opts.headers["X-MCP-Client"]).toBe(expected);
    expect(opts.headers["User-Agent"]).toBe(expected);
  });
});

describe("drupalFetch oauth integration", () => {
  it("sends a Bearer token sourced from the token manager", async () => {
    const site = oauthSite("of1");
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok-x", expires_in: 3600 }) })
      .mockResolvedValueOnce(ok());
    await drupalFetch(site, "/jsonapi/node/article");
    // call 0 is the token endpoint, call 1 is the JSON:API request
    const apiOpts = vi.mocked(fetch).mock.calls[1][1];
    expect(apiOpts.headers.Authorization).toBe("Bearer tok-x");
    clearToken(site);
  });

  it("on a 401 clears the token, re-acquires, and retries exactly once", async () => {
    const site = oauthSite("of2");
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok-old", expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "unauthorized" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok-new", expires_in: 3600 }) })
      .mockResolvedValueOnce(ok());
    const result = await drupalFetch(site, "/jsonapi/node/article");
    expect(result).toEqual({ data: [] });
    // token, failed-request, re-token, retried-request = 4 fetches
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
    const retryOpts = vi.mocked(fetch).mock.calls[3][1];
    expect(retryOpts.headers.Authorization).toBe("Bearer tok-new");
    clearToken(site);
  });

  it("does not retry a 401 for a static apiToken site", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401, text: async () => "nope" });
    await expect(drupalFetch({ _name: "st1", baseUrl: "https://x", apiToken: "static" }, "/jsonapi/node/article"))
      .rejects.toThrow(/401/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(fetch).mock.calls[0][1];
    expect(opts.headers.Authorization).toBe("Bearer static");
  });
});
