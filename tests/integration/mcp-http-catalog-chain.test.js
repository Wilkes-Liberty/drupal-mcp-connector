/**
 * DEV-1019: modern HTTP cannot bind a listen to a sessionless POST.
 * A 2026 sibling that listens must not shorten another 2026 client's first list.
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
import { createModuleToolRegistry } from "../../src/lib/module-tools.js";
import { clearToken } from "../../src/lib/oauth.js";
import { clearSiteCatalogCache, DEFAULT_UNNOTIFIED_LIST_WAIT_MS } from "../../src/lib/site-catalog.js";
import { clearGovernanceCache } from "../../src/lib/governance.js";
import {
  catalogListingIdentity,
  catalogSiteConfigs,
  startRealChainDrupal,
} from "../helpers/real-chain-drupal.js";

const closers = [];
const tokens = [];

afterEach(async () => {
  while (closers.length) await closers.pop()();
  while (tokens.length) clearToken(tokens.pop());
  clearCatalogNotifications();
  clearSiteCatalogCache();
  clearGovernanceCache();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function moduleToolCount(tools) {
  return tools.filter((tool) => /^drupal_module_read_ns\d+__item$/.test(tool.name)).length;
}

async function startCatalogHttpChain(siteCount = 13) {
  const drupal = await startRealChainDrupal(siteCount);
  closers.push(() => drupal.close());
  const sites = catalogSiteConfigs(drupal.baseUrl, siteCount);
  for (const site of sites) tokens.push(site);
  const identity = catalogListingIdentity(sites.map((site) => site._name));
  const registry = createModuleToolRegistry();
  const waits = [];
  const surface = {
    serverInfo: { name: "catalog-http-chain", version: "1.0.0" },
    tools: {
      definitions: [],
      list: async ({ waitMs } = {}) => {
        waits.push(waitMs);
        return registry.list({ sites, identity, waitMs });
      },
      call: async () => ({ content: [{ type: "text", text: "ok" }] }),
    },
    resources: {
      definitions: [],
      read: async (uri) => ({ uri, ok: true }),
    },
    prompts: {
      definitions: [],
      list: async ({ waitMs } = {}) => {
        waits.push(waitMs);
        return [];
      },
      get: () => [],
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
    { name: options.name ?? "catalog-http-chain-client", version: "1.0.0" },
    options.clientOptions ?? {},
  );
  closers.push(() => client.close());
  await client.connect(httpTransport(url));
  return client;
}

describe("HTTP catalog real-chain wait (DEV-1019)", () => {
  it("modern 2026 alone waits for the chain and advertises 13 module tools", async () => {
    const { url, waits } = await startCatalogHttpChain(13);
    const client = await connectClient(url, {
      name: "modern-alone",
      clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    });
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const started = performance.now();
    const listed = await client.listTools();
    const listMs = performance.now() - started;
    expect(waits.at(-1)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    expect(moduleToolCount(listed.tools)).toBe(13);
    expect(listMs).toBeGreaterThan(5_000);
    expect(listMs).toBeLessThan(25_000);
    const line = `[DEV-1019] HTTP modern alone waitMs=${waits.at(-1)} ` +
      `list=${Math.round(listMs)}ms moduleTools=${moduleToolCount(listed.tools)}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
  }, 40_000);

  it("a listening 2026 sibling does not shorten another 2026 client's wait or catalog", async () => {
    const { url, waits } = await startCatalogHttpChain(13);
    const listener = await connectClient(url, {
      name: "modern-listener",
      clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    });
    expect(listener.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const sub = await listener.listen({ toolsListChanged: true, promptsListChanged: true });
    await delay(50);
    const lonely = await connectClient(url, {
      name: "modern-lonely",
      clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    });
    expect(lonely.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const started = performance.now();
    const listed = await lonely.listTools();
    const listMs = performance.now() - started;
    expect(waits.at(-1)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    expect(moduleToolCount(listed.tools)).toBe(13);
    expect(listMs).toBeGreaterThan(5_000);
    expect(listMs).toBeLessThan(25_000);
    const line = `[DEV-1019] HTTP modern sibling-listen B waitMs=${waits.at(-1)} ` +
      `list=${Math.round(listMs)}ms moduleTools=${moduleToolCount(listed.tools)}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
    await sub.close();
  }, 40_000);
});
