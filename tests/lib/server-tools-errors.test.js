import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
import fetch from "node-fetch";
import { callServerTool, listServerTools } from "../../src/lib/server-tools.js";
import { classifyBridgeError } from "../../src/lib/verify.js";
import { ERROR_DETAIL_MAX_CHARS } from "../../src/lib/error-body.js";
import { DataFlowBudgetError, resetDataFlowBudgets } from "../../src/lib/data-flow.js";

/**
 * The bridge's errors reach the MCP client through every tool that calls it.
 * A response body and a tool's error text are untrusted: an HTML error page, a
 * server path or a backtrace must not be relayed, and the text must be bounded
 * (#362). The prefix, the HTTP status and the JSON-RPC code stay, because the
 * verifier and the callers read them.
 */

const TOOL = "tool_api__mcp_sentinel_config_set";

// Unique site per test: the bridge caches the MCP session by site.
let siteSeq = 0;
const plainSite = () => ({ _name: `errors-${++siteSeq}`, baseUrl: "https://x", serverTools: { url: "/mcp" } });

const mcpRes = ({ status = 200, sessionId = null, json, text, contentType = "application/json" } = {}) => ({
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
  text: async () => (text !== undefined ? text : json !== undefined ? JSON.stringify(json) : ""),
});

const initOk = (sessionId = "sess-1") => [
  mcpRes({ sessionId, json: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } } }),
  mcpRes({ status: 202, text: "" }),
];
const toolOk = (result) => mcpRes({ json: { jsonrpc: "2.0", id: 2, result } });

const HTML_PAGE =
  "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1>" +
  "<p>upstream php-fpm at /var/run/php/php8.3-fpm.sock failed</p><hr>nginx/1.25.3</body></html>";
const SERVER_PATH = "/var/www/html/web/modules/contrib/mcp_sentinel/src/Plugin/tool/McpConfigSet.php";
const TRACE = `Stack trace: #0 ${SERVER_PATH}(88): Drupal\\Core\\Config\\Config->save() #1 {main}`;

/** Run one request against scripted replies after a good handshake; return the thrown error. */
const failWith = async (responses, { call = callServerTool, options = { retryRejected: false } } = {}) => {
  const mock = vi.mocked(fetch);
  for (const response of [...initOk(), ...[].concat(responses)]) mock.mockResolvedValueOnce(response);
  const run = call === listServerTools ? listServerTools(plainSite()) : call(plainSite(), TOOL, {}, options);
  return run.then(() => { throw new Error("expected the call to fail"); }, (error) => error);
};

/** What no bridge error may hold. */
const expectClean = (message) => {
  expect(message).not.toMatch(/[<>]/);
  expect(message).not.toContain("/var/");
  expect(message).not.toContain("McpConfigSet.php");
  expect(message).not.toMatch(/#0|\{main\}/);
  expect(message).not.toContain("nginx/1.25.3");
  // Prefix + tool name + one bounded detail.
  expect(message.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX_CHARS + 120);
};

beforeEach(() => { vi.mocked(fetch).mockReset(); resetDataFlowBudgets(); });

describe("a non-2xx tools/call", () => {
  it("does not relay an HTML error page, and keeps the status", async () => {
    const error = await failWith(mcpRes({ status: 502, text: HTML_PAGE, contentType: "text/html" }));
    expect(error.message).toMatch(new RegExp(`^Server-tool call ${TOOL} failed 502: `));
    expect(error.message).toContain("HTML page, not shown");
    expect(error.message).toContain("502 Bad Gateway");
    expectClean(error.message);
  });

  it("redacts a server path in a JSON body", async () => {
    const error = await failWith(mcpRes({ status: 500, json: { message: `Cannot write ${SERVER_PATH}: permission denied` } }));
    expect(error.message).toMatch(new RegExp(`^Server-tool call ${TOOL} failed 500: `));
    expect(error.message).toContain("[path]");
    expect(error.message).toContain("permission denied");
    expectClean(error.message);
  });

  it("does not show a JSON body that is not an error document", async () => {
    const error = await failWith(mcpRes({ status: 500, json: { debug: { file: SERVER_PATH, trace: [TRACE] } } }));
    expect(error.message).toContain("failed 500: ");
    expectClean(error.message);
  });

  it("bounds an oversized body", async () => {
    const error = await failWith(mcpRes({ status: 500, text: "A".repeat(200000), contentType: "text/plain" }));
    expect(error.message).toMatch(new RegExp(`^Server-tool call ${TOOL} failed 500: A+`));
    expect(error.message).toContain("[truncated]");
    expectClean(error.message);
  });

  it("cuts a backtrace from a plain-text body", async () => {
    const error = await failWith(mcpRes({ status: 500, text: `The website encountered an unexpected error. ${TRACE}`, contentType: "text/plain" }));
    expect(error.message).toContain("unexpected error");
    expect(error.message).toContain("[stack trace removed]");
    expectClean(error.message);
  });

  it("keeps the status and the colon when the body is empty", async () => {
    const error = await failWith(mcpRes({ status: 403, text: "" }));
    expect(error.message).toBe(`Server-tool call ${TOOL} failed 403: the server returned an empty body`);
  });

  it("keeps a governed refusal readable", async () => {
    const refusal = "Access denied by MCP Sentinel policy: the mcp_config scope is required to write system.site.";
    const error = await failWith(mcpRes({ status: 403, json: { message: refusal } }));
    expect(error.message).toBe(`Server-tool call ${TOOL} failed 403: ${refusal}`);
  });

  it("keeps the code and the message of a JSON-RPC error sent with a 4xx or 5xx", async () => {
    const rpc = (message) => ({ jsonrpc: "2.0", id: 2, error: { code: -32000, message, data: { trace: TRACE } } });
    const refused = await failWith(mcpRes({ status: 403, json: rpc("denied by MCP Sentinel policy") }));
    expect(refused.message).toBe(`Server-tool call ${TOOL} failed 403: JSON-RPC error -32000: denied by MCP Sentinel policy`);
    expect(classifyBridgeError(refused).outcome).toBe("refused");

    // The status decides: a 500 is not a refusal, whatever code its body holds.
    const failed = await failWith(mcpRes({ status: 500, json: rpc(`<b>boom</b> in ${SERVER_PATH} ${TRACE}`) }));
    expect(failed.message).toMatch(new RegExp(`^Server-tool call ${TOOL} failed 500: JSON-RPC error -32000: boom in \\[path\\]`));
    expectClean(failed.message);
    expect(classifyBridgeError(failed).outcome).toBe("unexercised");
  });

  it("treats a catalog read the same way", async () => {
    const error = await failWith(mcpRes({ status: 502, text: HTML_PAGE, contentType: "text/html" }), { call: listServerTools });
    expect(error.message).toMatch(/^Server-tool call tools\/list failed 502: /);
    expectClean(error.message);
  });
});

describe("a JSON-RPC error object", () => {
  it("keeps the code and cleans the message", async () => {
    const message = `<b>Fatal error</b>: Uncaught TypeError in ${SERVER_PATH}:88 ${TRACE}`;
    const error = await failWith(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: -32000, message, data: { trace: TRACE } } } }));
    expect(error.message).toMatch(new RegExp(`^Server-tool ${TOOL} error \\(-32000\\): `));
    expect(error.message).toContain("Fatal error");
    expectClean(error.message);
  });

  it("bounds an oversized message and keeps a plain one as it is", async () => {
    const long = await failWith(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "B".repeat(50000) } } }));
    expect(long.message).toMatch(new RegExp(`^Server-tool ${TOOL} error \\(-32603\\): B+`));
    expectClean(long.message);

    const plain = await failWith(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } } }));
    expect(plain.message).toBe(`Server-tool ${TOOL} error (-32601): Method not found`);
  });

  it("does not print a code or a message that is not a number or a string", async () => {
    const error = await failWith(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: `<i>${SERVER_PATH}</i>`, message: { file: SERVER_PATH } } } }));
    expect(error.message).toBe(`Server-tool ${TOOL} error: the server returned no error message`);
  });
});

describe("a tool result with isError", () => {
  it("cleans and bounds the tool's text", async () => {
    const text = `<p>Config save failed in ${SERVER_PATH}</p> ${"C".repeat(5000)} ${TRACE}`;
    const error = await failWith(toolOk({ isError: true, content: [{ type: "text", text }] }));
    expect(error.message).toMatch(new RegExp(`^Server-tool ${TOOL} reported an error: Config save failed in \\[path\\]`));
    expectClean(error.message);
  });

  it("keeps a governed refusal readable", async () => {
    const refusal = "denied by MCP Sentinel policy: principal content-agent lacks scope mcp_config (rule config.write)";
    const error = await failWith(toolOk({ isError: true, content: [{ type: "text", text: refusal }] }));
    expect(error.message).toBe(`Server-tool ${TOOL} reported an error: ${refusal}`);
  });

  it("says so when the tool gave no text", async () => {
    const error = await failWith(toolOk({ isError: true, content: [] }));
    expect(error.message).toBe(`Server-tool ${TOOL} reported an error: tool reported an error`);
  });
});

describe("the session handshake", () => {
  const initFail = async (response) => {
    vi.mocked(fetch).mockResolvedValueOnce(response);
    return callServerTool(plainSite(), TOOL, {}).then(() => { throw new Error("expected a failure"); }, (e) => e);
  };

  it("does not relay an HTML error page", async () => {
    const error = await initFail(mcpRes({ status: 503, text: HTML_PAGE, contentType: "text/html" }));
    expect(error.message).toMatch(/^Server-tool session initialize failed 503: /);
    expect(error.message).toContain("HTML page, not shown");
    expectClean(error.message);
  });

  it("keeps the JSON-RPC code and cleans the message", async () => {
    const error = await initFail(mcpRes({ json: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: `boot failed in ${SERVER_PATH} ${TRACE}` } } }));
    expect(error.message).toMatch(/^Server-tool session initialize error \(-32000\): boot failed in \[path\]/);
    expectClean(error.message);
  });
});

describe("matchers that read a bridge failure still work", () => {
  it("re-initialises an expired session whatever the body looks like", async () => {
    const expiries = [
      mcpRes({ status: 404, text: HTML_PAGE, contentType: "text/html" }),
      mcpRes({ status: 400, json: { jsonrpc: "2.0", id: 2, error: { code: -32600, message: `<b>bad</b> ${"D".repeat(5000)}` } } }),
      mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: -32000, message: `${"E".repeat(2000)} Mcp-Session-Id: a valid session ID is REQUIRED` } } }),
    ];
    for (const expired of expiries) {
      vi.mocked(fetch).mockReset();
      const mock = vi.mocked(fetch);
      for (const response of [...initOk("old"), expired, ...initOk("new"), toolOk({ content: [{ type: "text", text: "{}" }] })]) {
        mock.mockResolvedValueOnce(response);
      }
      await expect(callServerTool(plainSite(), TOOL, {})).resolves.toBeTruthy();
      const calls = mock.mock.calls;
      expect(calls.length).toBe(6);
      expect(calls[5][1].headers["Mcp-Session-Id"]).toBe("new");
    }
  });

  it("maps a source budget denial before the text is cut", async () => {
    const padding = "F".repeat(ERROR_DETAIL_MAX_CHARS * 4);
    const http = await failWith(mcpRes({ status: 429, json: { errors: [{ detail: padding, code: "read_budget_exceeded" }] } }));
    expect(http).toBeInstanceOf(DataFlowBudgetError);

    const tool = await failWith(toolOk({ isError: true, content: [{ type: "text", text: `${padding} read_budget_exceeded` }] }));
    expect(tool).toBeInstanceOf(DataFlowBudgetError);
  });

  it("gives classifyBridgeError the same answers as before", async () => {
    const outcomeOf = async (...args) => classifyBridgeError(await failWith(...args)).outcome;

    expect(await outcomeOf(mcpRes({ status: 403, text: HTML_PAGE, contentType: "text/html" }))).toBe("refused");
    expect(await outcomeOf(mcpRes({ status: 403, text: "" }))).toBe("refused");
    expect(await outcomeOf(mcpRes({ status: 401, json: { message: "no" } }))).toBe("refused");
    expect(await outcomeOf(mcpRes({ status: 500, text: HTML_PAGE, contentType: "text/html" }))).toBe("unexercised");
    expect(await outcomeOf(mcpRes({ status: 500, text: "" }))).toBe("unexercised");
    expect(await outcomeOf(toolOk({ isError: true, content: [{ type: "text", text: "denied by policy" }] }))).toBe("refused");
    expect(await outcomeOf(toolOk({ isError: true, content: [] }))).toBe("refused");
    expect(await outcomeOf(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "<b>denied</b>" } } }))).toBe("refused");
    expect(await outcomeOf(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } } }))).toBe("unexercised");
    expect(await outcomeOf(mcpRes({ json: { jsonrpc: "2.0", id: 2, error: { code: -32000 } } }))).toBe("refused");

    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockResolvedValueOnce(mcpRes({ status: 503, text: HTML_PAGE, contentType: "text/html" }));
    const session = await callServerTool(plainSite(), TOOL, {}).catch((e) => e);
    expect(classifyBridgeError(session).outcome).toBe("unexercised");
  });
});
