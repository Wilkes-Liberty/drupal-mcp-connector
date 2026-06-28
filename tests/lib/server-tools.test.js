import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
import fetch from "node-fetch";
import { callServerTool, SERVER_TOOLS } from "../../src/lib/server-tools.js";
import { clearToken } from "../../src/lib/oauth.js";

// Unique site name per test keeps the module-scope session cache from leaking
// between cases (callServerTool caches the Mcp-Session-Id by site._name).
let siteSeq = 0;
const oauthSite = (over = {}) => ({
  _name: `dev-${++siteSeq}`,
  baseUrl: "https://x",
  serverTools: { url: "/mcp" },
  oauth: { tokenUrl: "/oauth/token", clientId: "c", clientSecret: "s", grant: "client_credentials", scopes: ["mcp_config"] },
  ...over,
});
const plainSite = (over = {}) => ({ _name: `s-${++siteSeq}`, baseUrl: "https://x", serverTools: { url: "/mcp" }, ...over });

// OAuth token-endpoint reply (oauth.js reads res.json()).
const tokenRes = (token = "tok-x") => ({ ok: true, status: 200, json: async () => ({ access_token: token, expires_in: 3600 }) });

// MCP server reply. serverTools reads res.headers.get() + res.text() only.
const mcpRes = ({ status = 200, sessionId = null, json, sse, text } = {}) => {
  const contentType = sse ? "text/event-stream" : "application/json";
  const bodyText = text !== undefined
    ? text
    : sse !== undefined
      ? sse
      : json !== undefined ? JSON.stringify(json) : "";
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h) => {
        const key = String(h).toLowerCase();
        if (key === "mcp-session-id") return sessionId;
        if (key === "content-type") return contentType;
        return null;
      },
    },
    text: async () => bodyText,
  };
};

// initialize reply carrying a session id, then the empty 202 for the notification.
const initOk = (sessionId = "sess-1") => [
  mcpRes({ sessionId, json: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } } }),
  mcpRes({ status: 202, text: "" }),
];
const toolOk = (result) => mcpRes({ json: { jsonrpc: "2.0", id: 2, result } });

beforeEach(() => { vi.mocked(fetch).mockReset(); });

describe("callServerTool", () => {
  it("performs the MCP handshake then posts tools/call with the session header", async () => {
    const site = oauthSite();
    clearToken(site);
    vi.mocked(fetch)
      .mockResolvedValueOnce(tokenRes("tok-x"))          // OAuth token
      .mockResolvedValueOnce(initOk("sess-1")[0])        // initialize
      .mockResolvedValueOnce(initOk("sess-1")[1])        // notifications/initialized
      .mockResolvedValueOnce(toolOk({ content: [{ type: "text", text: "{}" }] })); // tools/call

    await callServerTool(site, SERVER_TOOLS.configGet, { name: "system.site" });

    // Sequence: token, initialize, notifications/initialized, tools/call.
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBe(4);

    const [initUrl, initOpts] = calls[1];
    expect(initUrl).toBe("https://x/mcp");
    expect(JSON.parse(initOpts.body).method).toBe("initialize");
    expect(initOpts.headers["MCP-Protocol-Version"]).toBe("2025-06-18");
    expect(initOpts.headers.Accept).toContain("text/event-stream");

    const [, notifyOpts] = calls[2];
    expect(JSON.parse(notifyOpts.body).method).toBe("notifications/initialized");
    expect(notifyOpts.headers["Mcp-Session-Id"]).toBe("sess-1");

    const [toolUrl, toolOpts] = calls[3];
    expect(toolUrl).toBe("https://x/mcp");
    expect(toolOpts.method).toBe("POST");
    expect(toolOpts.headers.Authorization).toBe("Bearer tok-x");
    expect(toolOpts.headers["Mcp-Session-Id"]).toBe("sess-1");
    expect(toolOpts.headers["MCP-Protocol-Version"]).toBe("2025-06-18");
    expect(toolOpts.headers.Accept).toContain("text/event-stream");
    expect(JSON.parse(toolOpts.body)).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: SERVER_TOOLS.configGet, arguments: { name: "system.site" } },
    });
  });

  it("reuses a cached session across calls (one initialize)", async () => {
    const site = plainSite();
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk("sess-2")[0])
      .mockResolvedValueOnce(initOk("sess-2")[1])
      .mockResolvedValueOnce(toolOk({ content: [] }))
      .mockResolvedValueOnce(toolOk({ content: [] }));

    await callServerTool(site, SERVER_TOOLS.configList, {});
    await callServerTool(site, SERVER_TOOLS.configList, {});

    const methods = vi.mocked(fetch).mock.calls.map(([, o]) => JSON.parse(o.body).method);
    // initialize, notifications/initialized, tools/call, tools/call — no second initialize.
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
  });

  it("parses a text/event-stream tools/call response", async () => {
    const site = plainSite();
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { structuredContent: { a: 1 } } })}\n\n`;
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk("sess-3")[0])
      .mockResolvedValueOnce(initOk("sess-3")[1])
      .mockResolvedValueOnce(mcpRes({ sse }));

    const out = await callServerTool(site, SERVER_TOOLS.configGet, {});
    expect(out.structuredContent).toEqual({ a: 1 });
  });

  it("re-initialises once and replays on a -32600 session error", async () => {
    const site = plainSite();
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk("sess-a")[0])
      .mockResolvedValueOnce(initOk("sess-a")[1])
      .mockResolvedValueOnce(mcpRes({ status: 400, json: { jsonrpc: "2.0", id: 2, error: { code: -32600, message: "A valid session id is REQUIRED for non-initialize requests." } } }))
      .mockResolvedValueOnce(initOk("sess-b")[0])
      .mockResolvedValueOnce(initOk("sess-b")[1])
      .mockResolvedValueOnce(toolOk({ content: [{ type: "text", text: "ok" }] }));

    await callServerTool(site, SERVER_TOOLS.configGet, {});

    const calls = vi.mocked(fetch).mock.calls;
    const methods = calls.map(([, o]) => JSON.parse(o.body).method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "initialize", "notifications/initialized", "tools/call"]);
    // The replayed tools/call carries the new session id.
    expect(calls[5][1].headers["Mcp-Session-Id"]).toBe("sess-b");
  });

  it("retries once after a 401 on OAuth sites, preserving the session", async () => {
    const site = oauthSite();
    clearToken(site);
    vi.mocked(fetch)
      .mockResolvedValueOnce(tokenRes("tok-1"))          // token (for initialize)
      .mockResolvedValueOnce(initOk("sess-x")[0])        // initialize
      .mockResolvedValueOnce(initOk("sess-x")[1])        // notifications/initialized
      .mockResolvedValueOnce(mcpRes({ status: 401, text: "expired" })) // tools/call -> 401
      .mockResolvedValueOnce(tokenRes("tok-2"))          // token refresh
      .mockResolvedValueOnce(toolOk({ content: [] }));   // tools/call replay

    await callServerTool(site, SERVER_TOOLS.configGet, { name: "x" });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBe(6);
    // No second initialize — the session is reused across the auth refresh.
    // (Token-endpoint POSTs carry urlencoded bodies, so parse defensively.)
    const methodOf = (o) => { try { return JSON.parse(o.body).method; } catch { return null; } };
    const initCount = calls.filter(([, o]) => methodOf(o) === "initialize").length;
    expect(initCount).toBe(1);
    // Replayed tools/call uses the refreshed token and the same session.
    const replay = calls[5][1];
    expect(replay.headers.Authorization).toBe("Bearer tok-2");
    expect(replay.headers["Mcp-Session-Id"]).toBe("sess-x");
  });

  it("throws a clear error when serverTools is not configured", async () => {
    await expect(callServerTool({ _name: "prod", baseUrl: "https://x" }, "config_get", {}))
      .rejects.toThrow(/Server-tool bridge not configured/);
  });

  it("surfaces a JSON-RPC error from tools/call", async () => {
    const site = plainSite();
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk("sess-e")[0])
      .mockResolvedValueOnce(initOk("sess-e")[1])
      .mockResolvedValueOnce(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } } }));
    await expect(callServerTool(site, "config_get", {})).rejects.toThrow(/Method not found/);
  });

  it("surfaces an isError tool result", async () => {
    const site = plainSite();
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk("sess-f")[0])
      .mockResolvedValueOnce(initOk("sess-f")[1])
      .mockResolvedValueOnce(toolOk({ isError: true, content: [{ type: "text", text: "denied" }] }));
    await expect(callServerTool(site, "config_set", {})).rejects.toThrow(/denied/);
  });
});
