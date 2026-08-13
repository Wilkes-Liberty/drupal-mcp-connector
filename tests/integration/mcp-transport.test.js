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
    resources: {
      definitions: [{ uri: "drupal://test", name: "Test", mimeType: "application/json" }],
      read: async (uri) => ({ uri, ok: true }),
    },
    prompts: {
      definitions: [{ name: "drupal-test", description: "Test prompt" }],
      get: () => [{ role: "user", content: { type: "text", text: "test" } }],
    },
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

  it("authenticates before denying every captured modern header/body disagreement without fallback", async () => {
    const traffic = [];
    const builds = [];
    const url = await startServer({ onBuild: (context) => builds.push(context) });
    const client = new Client(
      { name: "modern-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    closers.push(() => client.close());
    await client.connect(httpTransport(url, captureFetch(traffic)));
    await client.listTools();
    await client.callTool({ name: "drupal_test", arguments: {} });
    await client.listResources();
    await client.readResource({ uri: "drupal://test" });
    await client.listPrompts();
    await client.getPrompt({ name: "drupal-test", arguments: {} });

    const call = traffic.find((request) => request.body?.method === "tools/call");
    expect(call).toBeDefined();
    expect(call.headers["mcp-session-id"]).toBeUndefined();
    expect(call.responseHeaders["mcp-session-id"]).toBeUndefined();

    const captured = traffic.filter((request) => request.method === "POST");
    expect(captured.map((request) => request.body.method)).toEqual([
      "server/discover",
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/read",
      "prompts/list",
      "prompts/get",
    ]);

    const disagreementCases = captured.flatMap((request, index) => {
      const cases = [
        {
          label: `${request.body.method} protocol`,
          request,
          header: "MCP-Protocol-Version",
          value: "2025-11-25",
        },
        {
          label: `${request.body.method} method`,
          request,
          header: "Mcp-Method",
          value: captured[(index + 1) % captured.length].body.method,
        },
      ];
      if (["tools/call", "resources/read", "prompts/get"].includes(request.body.method)) {
        expect(request.headers["mcp-name"], `${request.body.method} captured name`).toBeTruthy();
        cases.push({
          label: `${request.body.method} name`,
          request,
          header: "Mcp-Name",
          value: "definitely-not-the-body-name",
        });
      }
      return cases;
    });

    expect(disagreementCases.map(({ label }) => label)).toEqual([
      "server/discover protocol",
      "server/discover method",
      "tools/list protocol",
      "tools/list method",
      "tools/call protocol",
      "tools/call method",
      "tools/call name",
      "resources/list protocol",
      "resources/list method",
      "resources/read protocol",
      "resources/read method",
      "resources/read name",
      "prompts/list protocol",
      "prompts/list method",
      "prompts/get protocol",
      "prompts/get method",
      "prompts/get name",
    ]);

    const acceptedBuildCount = builds.length;
    for (const { label, request, header, value } of disagreementCases) {
      const deniedHeaders = new Headers(request.headers);
      deniedHeaders.delete("Authorization");
      deniedHeaders.set(header, value);
      const denied = await fetch(url, {
        method: "POST",
        headers: deniedHeaders,
        body: JSON.stringify(request.body),
      });
      expect(denied.status, `${label} before auth`).toBe(401);
      expect(await denied.text(), `${label} before auth`).toBe("Unauthorized");
      expect(builds, `${label} before auth`).toHaveLength(acceptedBuildCount);

      const headers = new Headers(request.headers);
      headers.set(header, value);
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(request.body),
      });
      expect(response.status, label).toBe(400);
      expect(await response.json(), label).toMatchObject({ error: { code: -32020 } });
      expect(builds, `${label} dispatch`).toHaveLength(acceptedBuildCount);
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

  it("denies a captured legacy initialize carrying modern claims without falling back", async () => {
    const builds = [];
    const traffic = [];
    const url = await startServer({ onBuild: (context) => builds.push(context) });
    const legacyClient = new Client({ name: "legacy-client", version: "1.0.0" });
    closers.push(() => legacyClient.close());
    await legacyClient.connect(httpTransport(url, captureFetch(traffic)));

    const initialize = traffic.find((request) => request.body?.method === "initialize");
    expect(initialize).toBeDefined();
    expect(builds).toEqual([{ era: "legacy" }]);
    const acceptedBuildCount = builds.length;

    const modernClaimHeaders = new Headers(initialize.headers);
    modernClaimHeaders.set("MCP-Protocol-Version", "2026-07-28");
    modernClaimHeaders.set("Mcp-Method", "initialize");

    const unauthenticatedHeaders = new Headers(modernClaimHeaders);
    unauthenticatedHeaders.delete("Authorization");
    const unauthenticated = await fetch(url, {
      method: "POST",
      headers: unauthenticatedHeaders,
      body: JSON.stringify(initialize.body),
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.text()).toBe("Unauthorized");
    expect(builds).toHaveLength(acceptedBuildCount);

    const ambiguous = await fetch(url, {
      method: "POST",
      headers: modernClaimHeaders,
      body: JSON.stringify(initialize.body),
    });
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({ error: { code: -32020 } });
    expect(builds).toHaveLength(acceptedBuildCount);
  });
});
