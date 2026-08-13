import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createLegacySessionHandler, createMcpRequestHandler } from "../../src/lib/http-handler.js";
import { createConnectorServerFactory } from "../../src/lib/mcp-server.js";

const closers = [];

afterEach(async () => {
  while (closers.length) await closers.pop()();
});

function surface(onToolCall = () => {}) {
  return {
    serverInfo: { name: "connector-transport-test", version: "1.0.0" },
    tools: {
      definitions: [{
        name: "drupal_test",
        description: "Test tool",
        inputSchema: { type: "object", properties: {} },
      }],
      call: async (name, args, context) => {
        onToolCall(context);
        return { content: [{ type: "text", text: JSON.stringify({ name, args }) }] };
      },
    },
    resources: { definitions: [], read: async () => ({}) },
    prompts: { definitions: [], get: () => [] },
  };
}

async function startServer({ onToolCall = () => {}, onBuild = () => {}, legacyMode = "serve" } = {}) {
  const baseFactory = createConnectorServerFactory(surface(onToolCall));
  const buildServer = (context) => {
    onBuild(context);
    return baseFactory(context);
  };
  const modernMcpHandler = createMcpHandler(buildServer, { legacy: "reject" });
  const handler = createMcpRequestHandler({
    checkAuth: (header) => header === "Bearer transport-secret",
    modernHandler: toNodeHandler(modernMcpHandler),
    legacyHandler: createLegacySessionHandler({ buildServer, mode: legacyMode }),
    toolCount: 1,
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    await modernMcpHandler.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

function httpTransport(url, fetchImpl = undefined) {
  return new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => "transport-secret" },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

function captureFetch(traffic) {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? await request.clone().json() : null;
    const response = await fetch(input, init);
    traffic.push({
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
      status: response.status,
      responseHeaders: Object.fromEntries(response.headers),
    });
    return response;
  };
}

describe("MCP transport integration", () => {
  it("negotiates 2026-07-28 with server/discover and serves stateless requests", async () => {
    const builds = [];
    const traffic = [];
    const toolContexts = [];
    const url = await startServer({
      onBuild: (context) => builds.push(context),
      onToolCall: (context) => toolContexts.push(context),
    });
    const client = new Client(
      { name: "modern-client", version: "1.0.0" },
      { capabilities: { roots: {} }, versionNegotiation: { mode: "auto" } }
    );
    closers.push(() => client.close());

    await client.connect(httpTransport(url, captureFetch(traffic)));
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["drupal_test"]);
    await client.callTool({ name: "drupal_test", arguments: { value: 1 } });

    expect(builds.length).toBeGreaterThanOrEqual(3);
    expect(builds.every((context) => context.era === "modern")).toBe(true);
    expect(traffic.some((request) => request.body?.method === "server/discover")).toBe(true);
    expect(traffic.every((request) => request.headers["mcp-session-id"] === undefined)).toBe(true);
    expect(traffic.every((request) => request.responseHeaders["mcp-session-id"] === undefined)).toBe(true);
    expect(toolContexts).toHaveLength(1);
    expect(toolContexts[0].mcpReq.envelope).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "modern-client", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": { roots: {} },
    });
  });

  it("preserves the existing sessionful 2025 HTTP contract", async () => {
    const builds = [];
    const traffic = [];
    const url = await startServer({ onBuild: (context) => builds.push(context) });
    const client = new Client({ name: "legacy-client", version: "1.0.0" });
    closers.push(() => client.close());

    await client.connect(httpTransport(url, captureFetch(traffic)));
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["drupal_test"]);
    await client.callTool({ name: "drupal_test", arguments: {} });

    expect(builds).toHaveLength(1);
    expect(builds[0].era).toBe("legacy");
    const initialize = traffic.find((request) => request.body?.method === "initialize");
    const initialized = traffic.find((request) => request.body?.method === "notifications/initialized");
    const list = traffic.find((request) => request.body?.method === "tools/list");
    expect(initialize.headers["mcp-session-id"]).toBeUndefined();
    expect(initialize.responseHeaders["mcp-session-id"]).toBeTruthy();
    expect(initialized.headers["mcp-session-id"]).toBe(initialize.responseHeaders["mcp-session-id"]);
    expect(list.headers["mcp-session-id"]).toBe(initialize.responseHeaders["mcp-session-id"]);
  });

  it("reject mode refuses legacy initialize without falling through", async () => {
    const builds = [];
    const url = await startServer({ legacyMode: "reject", onBuild: (context) => builds.push(context) });
    const client = new Client({ name: "legacy-client", version: "1.0.0" });

    await expect(client.connect(httpTransport(url))).rejects.toThrow(/400|legacy/i);
    expect(builds).toHaveLength(0);
  });

  it("denies every modern protocol, method, and name header/body disagreement", async () => {
    const traffic = [];
    const builds = [];
    const url = await startServer({ onBuild: (context) => builds.push(context) });
    const client = new Client(
      { name: "modern-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    closers.push(() => client.close());
    await client.connect(httpTransport(url, captureFetch(traffic)));
    await client.callTool({ name: "drupal_test", arguments: {} });

    const call = traffic.find((request) => request.body?.method === "tools/call");
    expect(call).toBeDefined();
    expect(call.headers["mcp-session-id"]).toBeUndefined();
    expect(call.responseHeaders["mcp-session-id"]).toBeUndefined();

    for (const [header, value] of [
      ["MCP-Protocol-Version", "2099-01-01"],
      ["Mcp-Method", "prompts/list"],
      ["Mcp-Name", "drupal_other"],
    ]) {
      const headers = new Headers(call.headers);
      headers.set(header, value);
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(call.body),
      });
      expect(response.status, header).toBe(400);
      expect(await response.json(), header).toMatchObject({ error: { code: -32020 } });
    }

    const unsupportedBody = structuredClone(call.body);
    unsupportedBody.params._meta["io.modelcontextprotocol/protocolVersion"] = "2099-01-01";
    const unsupportedHeaders = new Headers(call.headers);
    unsupportedHeaders.set("MCP-Protocol-Version", "2099-01-01");
    const unsupported = await fetch(url, {
      method: "POST",
      headers: unsupportedHeaders,
      body: JSON.stringify(unsupportedBody),
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ error: { code: -32022 } });

    const malformedBody = structuredClone(call.body);
    malformedBody.params._meta["io.modelcontextprotocol/clientCapabilities"] = "not-an-object";
    const malformed = await fetch(url, {
      method: "POST",
      headers: call.headers,
      body: JSON.stringify(malformedBody),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: -32602 } });

    const claimless = { jsonrpc: "2.0", id: 900, method: "tools/list", params: {} };
    const claimlessModernHeaders = new Headers({
      Authorization: "Bearer transport-secret",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    });
    const claimlessModern = await fetch(url, {
      method: "POST",
      headers: claimlessModernHeaders,
      body: JSON.stringify(claimless),
    });
    expect(claimlessModern.status).toBe(400);
    expect(await claimlessModern.json()).toMatchObject({ error: { code: -32602 } });

    const legacyHeaderOnModernClaim = new Headers(call.headers);
    legacyHeaderOnModernClaim.set("MCP-Protocol-Version", "2025-11-25");
    const crossEraMismatch = await fetch(url, {
      method: "POST",
      headers: legacyHeaderOnModernClaim,
      body: JSON.stringify(call.body),
    });
    expect(crossEraMismatch.status).toBe(400);
    expect(await crossEraMismatch.json()).toMatchObject({ error: { code: -32020 } });

    expect(builds.every((context) => context.era === "modern")).toBe(true);
  });
});
