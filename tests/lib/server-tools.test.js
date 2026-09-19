import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
import fetch from "node-fetch";
import {
  callServerTool,
  callGovernedServerTool,
  resolveServerToolName,
  serverToolCandidates,
  SERVER_TOOL_IDS,
  SERVER_TOOL_TIMEOUT_MS,
  SERVER_TOOL_MAX_BYTES,
} from "../../src/lib/server-tools.js";

// Transport tests need a wire name, not a resolved one.
const CONFIG_GET = "tool_api__mcp_sentinel_config_get";
const CONFIG_LIST = "tool_api__mcp_sentinel_config_list";
import { clearToken } from "../../src/lib/oauth.js";
import { httpStatusOf } from "../../src/lib/error-status.js";
import { classifyBridgeError } from "../../src/lib/verify.js";
import {
  HEADER_DECLARED_DESTINATION,
  buildDataFlowContext,
  resetDataFlowBudgets,
  runWithDataFlow,
} from "../../src/lib/data-flow.js";

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

function hangingFetch(_url, opts) {
  return new Promise((_, reject) => {
    const abort = () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (opts?.signal?.aborted) {
      abort();
      return;
    }
    opts?.signal?.addEventListener("abort", abort, { once: true });
  });
}

beforeEach(() => { vi.mocked(fetch).mockReset(); resetDataFlowBudgets(); });

describe("callServerTool", () => {
  it("keeps the private Drupal bridge sessionful and pinned to MCP 2025-06-18", async () => {
    const site = oauthSite();
    clearToken(site);
    vi.mocked(fetch)
      .mockResolvedValueOnce(tokenRes("tok-x"))          // OAuth token
      .mockResolvedValueOnce(initOk("sess-1")[0])        // initialize
      .mockResolvedValueOnce(initOk("sess-1")[1])        // notifications/initialized
      .mockResolvedValueOnce(toolOk({ content: [{ type: "text", text: "{}" }] })); // tools/call

    await callServerTool(site, CONFIG_GET, { name: "system.site" });

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
      params: { name: CONFIG_GET, arguments: { name: "system.site" } },
    });
    expect(toolOpts.size).toBe(SERVER_TOOL_MAX_BYTES);
    expect(toolOpts.signal).toBeInstanceOf(AbortSignal);
  });

  it("always attaches size and AbortSignal.timeout on tools/call, even without maxBytes", async () => {
    const site = plainSite();
    const fake = new AbortController().signal;
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(fake);
    try {
      vi.mocked(fetch)
        .mockResolvedValueOnce(initOk("sess-t")[0])
        .mockResolvedValueOnce(initOk("sess-t")[1])
        .mockResolvedValueOnce(toolOk({ content: [] }));
      await callServerTool(site, CONFIG_GET, {});
      const toolCall = vi.mocked(fetch).mock.calls.find(([, o]) => JSON.parse(o.body).method === "tools/call");
      expect(toolCall[1].size).toBe(SERVER_TOOL_MAX_BYTES);
      expect(toolCall[1].signal).toBe(fake);
      expect(spy).toHaveBeenCalledWith(SERVER_TOOL_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });

  it("aborts a hung tools/call so callGovernedServerTool cannot hang unbounded", async () => {
    const site = plainSite();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      originalTimeout(ms === SERVER_TOOL_TIMEOUT_MS ? 20 : ms));
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk("sess-hang")[0])
      .mockResolvedValueOnce(initOk("sess-hang")[1])
      .mockImplementation(hangingFetch);
    try {
      await expect(callServerTool(site, CONFIG_GET, {})).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      spy.mockRestore();
    }
  });

  it("reuses a cached session across calls (one initialize)", async () => {
    const site = plainSite();
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk("sess-2")[0])
      .mockResolvedValueOnce(initOk("sess-2")[1])
      .mockResolvedValueOnce(toolOk({ content: [] }))
      .mockResolvedValueOnce(toolOk({ content: [] }));

    await callServerTool(site, CONFIG_LIST, {});
    await callServerTool(site, CONFIG_LIST, {});

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

    const out = await callServerTool(site, CONFIG_GET, {});
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

    await callServerTool(site, CONFIG_GET, {});

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

    await callServerTool(site, CONFIG_GET, { name: "x" });

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

  it("sends declared destination on the governed tools/call", async () => {
    const site = plainSite();
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk("sess-g")[0])
      .mockResolvedValueOnce(initOk("sess-g")[1])
      .mockResolvedValueOnce(toolOk({ content: [] }));
    const flow = buildDataFlowContext({
      identity: { sub: "alice", clientId: "content-agent" },
      target: { name: "production", source: "grant" },
      site: { security: { declaredCeiling: "internal" } },
      correlationId: "corr-st",
    });
    await runWithDataFlow(flow, () => callServerTool(site, CONFIG_GET, { name: "system.site" }));
    const toolCall = vi.mocked(fetch).mock.calls.find(([, opts]) =>
      JSON.parse(opts.body).method === "tools/call");
    expect(toolCall[1].headers[HEADER_DECLARED_DESTINATION]).toBe("content-agent:production");
  });
});

describe("module catalog transport", () => {
  it("uses tools/list with an opaque empty cursor and bounded response", async () => {
    const { listServerTools } = await import("../../src/lib/server-tools.js");
    const site = plainSite();
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk()[0])
      .mockResolvedValueOnce(initOk()[1])
      .mockResolvedValueOnce(toolOk({ tools: [], nextCursor: "next" }));
    expect(await listServerTools(site, "")).toEqual({ tools: [], nextCursor: "next" });
    const options = vi.mocked(fetch).mock.calls.at(-1)[1];
    expect(JSON.parse(options.body)).toMatchObject({ method: "tools/list", params: { cursor: "" } });
    expect(options.size).toBe(SERVER_TOOL_MAX_BYTES);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not retry an opted-out write after session rejection", async () => {
    const site = plainSite();
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk()[0])
      .mockResolvedValueOnce(initOk()[1])
      .mockResolvedValueOnce(mcpRes({ status: 404, text: "session missing" }));
    await expect(callServerTool(site, "tool_api.example_write", {}, { retryRejected: false })).rejects.toThrow();
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => JSON.parse(options.body).method === "tools/call")).toHaveLength(1);
  });

  it("does not share sessions after a source credential changes", async () => {
    const site = plainSite({ apiToken: "first-synthetic-token" });
    for (const session of ["first", "second"]) {
      vi.mocked(fetch)
        .mockResolvedValueOnce(initOk(session)[0])
        .mockResolvedValueOnce(initOk(session)[1])
        .mockResolvedValueOnce(toolOk({ content: [] }));
    }
    await callServerTool(site, "tool_api.example", {});
    await callServerTool({ ...site, apiToken: "second-synthetic-token" }, "tool_api.example", {});
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => JSON.parse(options.body).method === "initialize")).toHaveLength(2);
  });
});

describe("governed config tool names are resolved from the source catalog", () => {
  const listing = (...names) => vi.fn(async () => ({ tools: names.map((name) => ({ name })) }));

  it("knows the Tool API ids and offers the double-underscore wire name first", () => {
    expect(SERVER_TOOL_IDS).toEqual({
      configGet: "mcp_sentinel_config_get",
      configList: "mcp_sentinel_config_list",
      configSet: "mcp_sentinel_config_set",
    });
    expect(serverToolCandidates("mcp_sentinel_config_set")).toEqual([
      "tool_api__mcp_sentinel_config_set",
      "tool_api.mcp_sentinel_config_set",
    ]);
  });

  it("uses the double-underscore name a current bridge advertises", async () => {
    const list = listing("tool_api__mcp_sentinel_config_get", "tool_api__other");
    await expect(resolveServerToolName(plainSite(), "configGet", { list })).resolves.toBe("tool_api__mcp_sentinel_config_get");
  });

  it("uses the dotted name when that is the one the catalog lists", async () => {
    const list = listing("tool_api.mcp_sentinel_config_get");
    await expect(resolveServerToolName(plainSite(), "configGet", { list })).resolves.toBe("tool_api.mcp_sentinel_config_get");
  });

  it("prefers the double-underscore name when the catalog lists both", async () => {
    const list = listing("tool_api.mcp_sentinel_config_set", "tool_api__mcp_sentinel_config_set");
    await expect(resolveServerToolName(plainSite(), "configSet", { list })).resolves.toBe("tool_api__mcp_sentinel_config_set");
  });

  it("finds the tool on a later catalog page", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ tools: [{ name: "tool_api__other" }], nextCursor: "p2" })
      .mockResolvedValueOnce({ tools: [{ name: "tool_api__mcp_sentinel_config_list" }] });
    await expect(resolveServerToolName(plainSite(), "configList", { list })).resolves.toBe("tool_api__mcp_sentinel_config_list");
    expect(list.mock.calls[1][1]).toBe("p2");
  });

  it("fails closed when the source advertises neither name", async () => {
    const list = listing("tool_api__mcp_sentinel_config_get_extra", "mcp_sentinel_config_get");
    await expect(resolveServerToolName(plainSite(), "configGet", { list }))
      .rejects.toThrow(/not advertised by the source/);
  });

  it("fails closed on an unknown binding, a malformed catalog and a repeated cursor", async () => {
    await expect(resolveServerToolName(plainSite(), "toString", { list: listing() })).rejects.toThrow(/Unknown server tool/);
    await expect(resolveServerToolName(plainSite(), "configGet", { list: vi.fn(async () => ({})) }))
      .rejects.toThrow(/catalog/i);
    const looping = vi.fn(async () => ({ tools: [], nextCursor: "same" }));
    await expect(resolveServerToolName(plainSite(), "configGet", { list: looping })).rejects.toThrow(/catalog/i);
  });

  it("calls the advertised name, and makes no call when the tool is not advertised", async () => {
    const site = plainSite();
    const catalog = (names) => toolOk({ tools: names.map((name) => ({ name })) });
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk("sess-r")[0])
      .mockResolvedValueOnce(initOk("sess-r")[1])
      .mockResolvedValueOnce(catalog(["tool_api__mcp_sentinel_config_get"]))
      .mockResolvedValueOnce(toolOk({ content: [{ type: "text", text: "{}" }] }));
    await callGovernedServerTool(site, "configGet", { name: "system.site" });
    const bodies = vi.mocked(fetch).mock.calls.map(([, o]) => JSON.parse(o.body));
    expect(bodies.map((b) => b.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(bodies[3].params).toEqual({ name: "tool_api__mcp_sentinel_config_get", arguments: { name: "system.site" } });
    const toolCall = vi.mocked(fetch).mock.calls.find(([, o]) => JSON.parse(o.body).method === "tools/call");
    expect(toolCall[1].size).toBe(SERVER_TOOL_MAX_BYTES);
    expect(toolCall[1].signal).toBeInstanceOf(AbortSignal);

    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockResolvedValueOnce(catalog(["tool_api__unrelated"]));
    await expect(callGovernedServerTool(site, "configSet", { name: "system.site", data: {} }))
      .rejects.toThrow(/not advertised by the source/);
    const methods = vi.mocked(fetch).mock.calls.map(([, o]) => JSON.parse(o.body).method);
    expect(methods).toEqual(["tools/list"]);
  });
});

describe("bridge errors say what failed (#361)", () => {
  /** Run one tools/call against a scripted reply and return the thrown error. */
  const failWith = async (response, options) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(initOk("sess-e")[0])
      .mockResolvedValueOnce(initOk("sess-e")[1])
      .mockResolvedValueOnce(response);
    return callServerTool(plainSite(), CONFIG_GET, {}, { retryRejected: false, ...options }).then(
      () => { throw new Error("expected the call to fail"); },
      (error) => error,
    );
  };

  it("sets the response status on a non-2xx tools/call", async () => {
    const error = await failWith(mcpRes({ status: 500, text: "{\"error\":\"upstream call failed 403: denied\"}" }));
    expect(error.status).toBe(500);
    expect(error.bridgeFailure).toBe("http");
    expect(httpStatusOf(error)).toBe(500);
    expect(classifyBridgeError(error).outcome).toBe("unexercised");
  });

  it("scores a real 403 on the tools/call as a refusal", async () => {
    const error = await failWith(mcpRes({ status: 403, text: "forbidden" }));
    expect(error.status).toBe(403);
    expect(classifyBridgeError(error).outcome).toBe("refused");
  });

  it("marks a JSON-RPC error with its code and no HTTP status", async () => {
    const spoof = "upstream failed 403: error (-32000): denied";
    const error = await failWith(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: -32602, message: spoof } } }));
    expect(error.bridgeFailure).toBe("rpc");
    expect(error.rpcCode).toBe(-32602);
    expect(error.status).toBeUndefined();
    expect(classifyBridgeError(error).outcome).toBe("unexercised");

    const denied = await failWith(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "access denied" } } }));
    expect(denied.rpcCode).toBe(-32000);
    expect(classifyBridgeError(denied).outcome).toBe("refused");
  });

  it("keeps a JSON-RPC code that is not an integer off the error", async () => {
    const error = await failWith(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: "-32000", message: "denied" } } }));
    expect(error.bridgeFailure).toBe("rpc");
    expect(error.rpcCode).toBeUndefined();
    expect(classifyBridgeError(error).outcome).toBe("unexercised");
  });

  it("marks a tool error from a 200, whatever numbers its text holds", async () => {
    const error = await failWith(toolOk({ isError: true, content: [{ type: "text", text: "call failed 500: error (-32601): nope" }] }));
    expect(error.bridgeFailure).toBe("tool");
    expect(error.status).toBeUndefined();
    expect(classifyBridgeError(error).outcome).toBe("refused");
  });

  it("marks a failed session handshake, which is never a refusal", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mcpRes({ status: 403, text: "forbidden" }));
    const error = await callServerTool(plainSite(), CONFIG_GET, {}).catch((e) => e);
    expect(error.status).toBe(403);
    expect(error.bridgeFailure).toBe("session");
    expect(classifyBridgeError(error).outcome).toBe("unexercised");

    vi.mocked(fetch).mockResolvedValueOnce(mcpRes({ json: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "denied" } } }));
    const rpc = await callServerTool(plainSite(), CONFIG_GET, {}).catch((e) => e);
    expect(rpc.bridgeFailure).toBe("session");
    expect(classifyBridgeError(rpc).outcome).toBe("unexercised");
  });
});
