/**
 * DEV-1019: Streamable HTTP catalog wait is per session.
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createLegacySessionHandler, createMcpRequestHandler } from "../../src/lib/http-handler.js";
import { createConnectorServerFactory } from "../../src/lib/mcp-server.js";
import {
  addModernCatalogNotifier,
  clearCatalogNotifications,
} from "../../src/lib/catalog-notify.js";
import { DEFAULT_UNNOTIFIED_LIST_WAIT_MS } from "../../src/lib/site-catalog.js";

const closers = [];

afterEach(async () => {
  while (closers.length) await closers.pop()();
  clearCatalogNotifications();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startCatalogHttpServer() {
  const waits = [];
  const surface = {
    serverInfo: { name: "catalog-http-test", version: "1.0.0" },
    tools: {
      definitions: [{
        name: "drupal_test",
        description: "Test tool",
        inputSchema: { type: "object", properties: {} },
      }],
      list: async ({ waitMs } = {}) => {
        waits.push(waitMs);
        return surface.tools.definitions;
      },
      call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
    resources: {
      definitions: [{ uri: "drupal://test", name: "Test", mimeType: "application/json" }],
      read: async (uri) => ({ uri, ok: true }),
    },
    prompts: {
      definitions: [{ name: "drupal-test", description: "Test prompt" }],
      list: async ({ waitMs } = {}) => {
        waits.push(waitMs);
        return surface.prompts.definitions;
      },
      get: () => [{ role: "user", content: { type: "text", text: "test" } }],
    },
  };
  const buildServer = createConnectorServerFactory(surface);
  const modernMcpHandler = createMcpHandler(buildServer, { legacy: "reject" });
  const detach = addModernCatalogNotifier(modernMcpHandler);
  const handler = createMcpRequestHandler({
    checkAuth: (header) => header === "Bearer transport-secret",
    allowLocalOperator: true,
    modernHandler: toNodeHandler(modernMcpHandler),
    legacyHandler: createLegacySessionHandler({ buildServer, mode: "serve" }),
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    detach();
    await modernMcpHandler.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    waits,
  };
}

function httpTransport(url) {
  return new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => "transport-secret" },
  });
}

async function connectClient(url, options = {}) {
  const client = new Client(
    { name: options.name ?? "catalog-http-client", version: "1.0.0" },
    options.clientOptions ?? {},
  );
  closers.push(() => client.close());
  await client.connect(httpTransport(url));
  return client;
}

describe("HTTP catalog list wait (DEV-1019)", () => {
  it("legacy 2025 gives 4000", async () => {
    const { url, waits } = await startCatalogHttpServer();
    const client = await connectClient(url);
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    await client.listTools();
    expect(waits.at(-1)).toBe(4000);
    const line = `[DEV-1019] HTTP legacy waitMs=${waits.at(-1)}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
  });

  it("modern 2026 with no listen gives 20000", async () => {
    const { url, waits } = await startCatalogHttpServer();
    const client = await connectClient(url, {
      clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    });
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    await client.listTools();
    expect(waits.at(-1)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    const line = `[DEV-1019] HTTP modern no-listen waitMs=${waits.at(-1)}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
  });

  it("modern 2026 with listen() still uses the unnotified wait", async () => {
    const { url, waits } = await startCatalogHttpServer();
    const client = await connectClient(url, {
      clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    });
    await client.listTools();
    expect(waits.at(-1)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    const sub = await client.listen({ toolsListChanged: true, promptsListChanged: true });
    await delay(50);
    await client.listTools();
    expect(waits.at(-1)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    await sub.close();
    await delay(50);
    await client.listTools();
    expect(waits.at(-1)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    const line = `[DEV-1019] HTTP modern listen waitMs=${waits.slice(-3).join(",")}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
  });

  it("modern 2026 with ClientOptions.listChanged still uses the unnotified wait", async () => {
    const { url, waits } = await startCatalogHttpServer();
    const client = await connectClient(url, {
      clientOptions: {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        listChanged: {
          tools: { onChanged: () => {} },
        },
      },
    });
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(client.autoOpenedSubscription).toBeDefined();
    await client.listTools();
    expect(waits.at(-1)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    const line = `[DEV-1019] HTTP modern listChanged waitMs=${waits.at(-1)}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
  });

  it("a 2025 session alongside a 2026 no-listen session leaves the 2026 one at 20000", async () => {
    const { url, waits } = await startCatalogHttpServer();
    const legacy = await connectClient(url, { name: "legacy-http" });
    expect(legacy.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    await legacy.listTools();
    expect(waits.at(-1)).toBe(4000);
    const modern = await connectClient(url, {
      name: "modern-http",
      clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    });
    expect(modern.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    await modern.listTools();
    expect(waits.at(-1)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    const line = `[DEV-1019] HTTP mixed legacy=${waits.at(-2)} modern=${waits.at(-1)}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
  });
});
