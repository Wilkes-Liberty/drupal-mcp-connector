import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
import fetch from "node-fetch";
import { callServerTool, SERVER_TOOLS } from "../../src/lib/server-tools.js";
import { clearToken } from "../../src/lib/oauth.js";

const oauthSite = (over = {}) => ({
  _name: "dev",
  baseUrl: "https://x",
  serverTools: { url: "/mcp" },
  oauth: { tokenUrl: "/oauth/token", clientId: "c", clientSecret: "s", grant: "client_credentials", scopes: ["mcp_config"] },
  ...over,
});

const rpcOk = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });

beforeEach(() => { vi.mocked(fetch).mockReset(); });

describe("callServerTool", () => {
  it("posts JSON-RPC tools/call to the resolved endpoint with a Bearer token", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok-x", expires_in: 3600 }) })
      .mockResolvedValueOnce(rpcOk({ content: [{ type: "text", text: "{}" }] }));

    await callServerTool(oauthSite(), SERVER_TOOLS.configGet, { name: "system.site" });

    const [url, opts] = vi.mocked(fetch).mock.calls[1];
    expect(url).toBe("https://x/mcp");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok-x");
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "config_get", arguments: { name: "system.site" } } });
  });

  it("returns the tools/call result on success", async () => {
    vi.mocked(fetch).mockResolvedValue(rpcOk({ content: [{ type: "text", text: "ok" }], structuredContent: { a: 1 } }));
    const out = await callServerTool({ _name: "s", baseUrl: "https://x", serverTools: { url: "/mcp" } }, "config_list", {});
    expect(out.structuredContent).toEqual({ a: 1 });
  });

  it("throws a clear error when serverTools is not configured", async () => {
    await expect(callServerTool({ _name: "prod", baseUrl: "https://x" }, "config_get", {}))
      .rejects.toThrow(/Server-tool bridge not configured/);
  });

  it("surfaces a JSON-RPC error", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }) });
    await expect(callServerTool({ _name: "s", baseUrl: "https://x", serverTools: { url: "/mcp" } }, "config_get", {}))
      .rejects.toThrow(/Method not found/);
  });

  it("surfaces an isError tool result", async () => {
    vi.mocked(fetch).mockResolvedValue(rpcOk({ isError: true, content: [{ type: "text", text: "denied" }] }));
    await expect(callServerTool({ _name: "s", baseUrl: "https://x", serverTools: { url: "/mcp" } }, "config_set", {}))
      .rejects.toThrow(/denied/);
  });

  it("retries once after a 401 on OAuth sites", async () => {
    const site = oauthSite();
    clearToken(site);
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok-1", expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "expired" })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok-2", expires_in: 3600 }) })
      .mockResolvedValueOnce(rpcOk({ content: [] }));

    await callServerTool(site, SERVER_TOOLS.configGet, { name: "x" });
    // token, attempt(401), token-refresh, attempt(200) = 4 calls
    expect(vi.mocked(fetch).mock.calls.length).toBe(4);
  });
});
