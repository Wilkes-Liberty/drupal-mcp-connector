/**
 * DEV-1019 real per-site chain: token, readiness, then initialize /
 * notifications/initialized / tools/list (and detached prompt hops).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sites: [] }));
vi.mock("node-fetch", () => ({ default: vi.fn() }));
vi.mock("../../src/lib/config.js", async (original) => ({
  ...await original(),
  getSiteConfig: vi.fn((name) => state.sites.find((s) => s._name === name)),
  listSiteNames: vi.fn(() => state.sites.map((s) => s._name)),
  getInboundGrants: () => null,
  getDefaultSiteName: () => state.sites[0]?._name ?? "estate0",
}));

import fetch from "node-fetch";
import { subscribeCatalogNotifications, clearCatalogNotifications } from "../../src/lib/catalog-notify.js";
import { createModuleToolRegistry } from "../../src/lib/module-tools.js";
import { clearToken } from "../../src/lib/oauth.js";
import { CATALOG_LIST_BUDGET_MS, clearSiteCatalogCache } from "../../src/lib/site-catalog.js";
import { clearGovernanceCache } from "../../src/lib/governance.js";
import { TOKEN_MS, READY_MS, MCP_MS } from "../helpers/real-chain-drupal.js";
const SCHEMA = {
  type: "object", required: ["id"], additionalProperties: false,
  properties: { id: { type: "integer", minimum: 1 } },
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function moduleSite(name, namespace, host, extra = {}) {
  return {
    _name: name,
    baseUrl: `https://${host}.example.com`,
    requireGovernance: true,
    security: { preset: "development", readOnly: false },
    oauth: {
      tokenUrl: "/oauth/token",
      clientId: "c",
      clientSecret: "s",
      grant: "client_credentials",
      scopes: ["mcp_config"],
    },
    serverTools: {
      url: "/mcp",
      modules: {
        namespace,
        tools: { item: { name: "tool_api.item", operation: "read", scope: "module_access", capabilities: [] } },
        workflows: {
          review: {
            description: "Review.",
            readOnly: true,
            tools: ["item"],
            instructions: "Call {tool:item}.",
          },
        },
        ...extra,
      },
    },
  };
}

function listingIdentity(siteNames) {
  return {
    iss: "https://idp.example/realms/agents",
    sub: "catalog-operator",
    azp: "catalog-agent",
    clientId: "catalog-agent",
    scopes: ["module_access"],
    sites: siteNames,
  };
}

function jsonRes(status, body, headers = {}) {
  const text = body === undefined || body === null ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        if (headers[key] !== undefined) return headers[key];
        if (key === "content-type") return "application/json";
        return null;
      },
    },
    json: async () => body,
    text: async () => text,
  };
}

function useSites(sites) {
  state.sites = sites;
  return sites;
}

function installRealChainFetch({
  denyGovernance = new Set(),
  errorSites = new Set(),
  counts,
  slowPromptRequestsAfter = Infinity,
} = {}) {
  let promptRequests = 0;
  vi.mocked(fetch).mockImplementation(async (url, opts) => {
    const u = String(url);
    if (u.includes("/oauth/token")) {
      counts.token += 1;
      await delay(TOKEN_MS);
      return jsonRes(200, { access_token: "tok-x", expires_in: 3600 });
    }
    if (u.includes("/drupal-mcp/readiness")) {
      counts.readiness += 1;
      await delay(READY_MS);
      const site = state.sites.find((item) => u.startsWith(`${item.baseUrl}/`));
      if (site && denyGovernance.has(site._name)) {
        return jsonRes(200, { contract_ready: false, reason: "contract_not_ready" });
      }
      return jsonRes(200, { contract_ready: true });
    }
    if (u.includes("/mcp")) {
      const body = JSON.parse(opts?.body || "{}");
      const site = state.sites.find((item) => u.startsWith(`${item.baseUrl}/`));
      if (site && errorSites.has(site._name) && body.method === "tools/list") {
        await delay(MCP_MS);
        counts.mcp.toolsList += 1;
        return jsonRes(500, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "upstream" } });
      }
      await delay(MCP_MS);
      if (body.method === "initialize") {
        counts.mcp.initialize += 1;
        return jsonRes(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-06-18", capabilities: {} },
        }, { "mcp-session-id": `sess-${site?._name ?? "x"}` });
      }
      if (body.method === "notifications/initialized") {
        counts.mcp.initialized += 1;
        return { ok: true, status: 202, headers: { get: () => null }, json: async () => null, text: async () => "" };
      }
      if (body.method === "tools/list") {
        counts.mcp.toolsList += 1;
        return jsonRes(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "tool_api.item", inputSchema: SCHEMA, outputSchema: SCHEMA }] },
        });
      }
      if (body.method === "prompts/list") {
        counts.mcp.promptsList += 1;
        return jsonRes(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: { prompts: [{ name: "review", description: "Remote." }] },
        });
      }
      if (body.method === "prompts/get") {
        if (++promptRequests > slowPromptRequestsAfter) await delay(1_500);
        counts.mcp.promptsGet += 1;
        return jsonRes(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: { messages: [{ role: "user", content: { type: "text", text: "Call {tool:item}." } }] },
        });
      }
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

beforeEach(() => {
  clearSiteCatalogCache();
  clearCatalogNotifications();
  clearGovernanceCache();
  state.sites = [];
  vi.mocked(fetch).mockReset();
});

afterEach(() => {
  for (const site of state.sites) clearToken(site);
  clearSiteCatalogCache();
  clearCatalogNotifications();
  clearGovernanceCache();
});

describe("DEV-1019 real catalog chain", () => {
  it("omits the cold list, then list_changed, then a cache-hit warm list of 13 sites", async () => {
    const sites = useSites(Array.from({ length: 13 }, (_, i) => (
      moduleSite(`estate${i}`, `ns${i}`, `host${i % 3}`)
    )));
    const counts = {
      token: 0,
      readiness: 0,
      mcp: { initialize: 0, initialized: 0, toolsList: 0, promptsList: 0, promptsGet: 0 },
    };
    // Exercise independently completing prompt discovery on the last two sites.
    installRealChainFetch({ counts, slowPromptRequestsAfter: 11 });
    const events = [];
    const stop = subscribeCatalogNotifications((event) => events.push({ ...event, at: performance.now() }));
    const registry = createModuleToolRegistry();
    const identity = listingIdentity(sites.map((site) => site._name));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const timings = { coldMs: 0, toolsListChangedMs: 0, promptsListChangedMs: 0, warmMs: 0 };
    try {
      const started = performance.now();
      const cold = await registry.list({ sites, identity });
      timings.coldMs = performance.now() - started;
      expect(timings.coldMs).toBeLessThan(CATALOG_LIST_BUDGET_MS);
      expect(cold).toHaveLength(0);
      expect(counts.mcp.promptsList).toBe(0);
      expect(counts.mcp.promptsGet).toBe(0);

      const deadline = Date.now() + 20_000;
      let ready = [];
      while (Date.now() < deadline) {
        ready = await registry.list({ sites, identity, waitMs: 0, logPending: false });
        // One prompt notification does not mean every detached site has finished.
        if (ready.length === 13 && counts.mcp.promptsGet === sites.length
          && events.some((event) => event.tools) && events.some((event) => event.prompts)) {
          timings.toolsListChangedMs = events.findLast((event) => event.tools).at - started;
          timings.promptsListChangedMs = events.findLast((event) => event.prompts).at - started;
          break;
        }
        await delay(50);
      }
      expect(ready).toHaveLength(13);
      expect(events.some((event) => event.tools)).toBe(true);
      expect(events.some((event) => event.prompts)).toBe(true);
      expect(timings.toolsListChangedMs).toBeGreaterThan(7_000);
      expect(timings.toolsListChangedMs).toBeLessThan(11_000);

      const warmStarted = performance.now();
      const warm = await registry.list({ sites, identity });
      timings.warmMs = performance.now() - warmStarted;
      expect(warm).toHaveLength(13);
      expect(timings.warmMs).toBeLessThan(2_000);
      expect(counts.mcp.toolsList).toBe(13);
      expect(counts.mcp.initialize).toBe(13);
      expect(counts.mcp.initialized).toBe(13);
      expect(counts.mcp.promptsList).toBe(13);
      expect(counts.mcp.promptsGet).toBe(13);
      const line = `[DEV-1019] real-chain timings: cold=${Math.round(timings.coldMs)}ms ` +
        `tools_list_changed=${Math.round(timings.toolsListChangedMs)}ms ` +
        `prompts_list_changed=${Math.round(timings.promptsListChangedMs)}ms ` +
        `warm=${Math.round(timings.warmMs)}ms`;
      console.error(line);
      process.stdout.write(`${line}\n`);
    } finally {
      stop();
      stderr.mockRestore();
    }
  }, 30_000);

  it("never grants a site that errors or fails governance", async () => {
    const ok = moduleSite("ok", "ok_ns", "host0");
    const bad = moduleSite("bad", "bad_ns", "host1");
    const denied = moduleSite("denied", "denied_ns", "host2");
    useSites([ok, bad, denied]);
    const counts = {
      token: 0,
      readiness: 0,
      mcp: { initialize: 0, initialized: 0, toolsList: 0, promptsList: 0, promptsGet: 0 },
    };
    installRealChainFetch({
      counts,
      errorSites: new Set(["bad"]),
      denyGovernance: new Set(["denied"]),
    });
    const registry = createModuleToolRegistry();
    const identity = listingIdentity(["ok", "bad", "denied"]);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cold = await registry.list({
        sites: [ok, bad, denied], identity, siteDeadlineMs: 80, logPending: false,
      });
      expect(cold).toHaveLength(0);
      const deadline = Date.now() + 20_000;
      let names = [];
      while (Date.now() < deadline) {
        const listed = await registry.list({
          sites: [ok, bad, denied], identity, waitMs: 0, logPending: false,
        });
        names = listed.map((item) => item.name);
        if (names.includes("drupal_module_read_ok_ns__item")) break;
        await delay(50);
      }
      expect(names).toEqual(["drupal_module_read_ok_ns__item"]);
      expect(names.join(" ")).not.toMatch(/bad_ns|denied_ns/);
    } finally {
      stderr.mockRestore();
    }
  }, 25_000);

  it("hides module tools when no site verifies the catalog", async () => {
    const sites = useSites([
      moduleSite("g0", "g0_ns", "host0"),
      moduleSite("g1", "g1_ns", "host1"),
    ]);
    const counts = {
      token: 0,
      readiness: 0,
      mcp: { initialize: 0, initialized: 0, toolsList: 0, promptsList: 0, promptsGet: 0 },
    };
    installRealChainFetch({
      counts,
      denyGovernance: new Set(["g0", "g1"]),
    });
    const registry = createModuleToolRegistry();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const listed = await registry.list({
        sites,
        identity: listingIdentity(["g0", "g1"]),
        siteDeadlineMs: 200,
      });
      expect(listed).toHaveLength(0);
      await delay(1_200);
      expect(await registry.list({
        sites,
        identity: listingIdentity(["g0", "g1"]),
        siteDeadlineMs: 200,
      })).toHaveLength(0);
    } finally {
      stderr.mockRestore();
    }
  }, 15_000);

  it("waits for the real chain on the first list when list_changed cannot be delivered", async () => {
    const sites = useSites(Array.from({ length: 13 }, (_, i) => (
      moduleSite(`wait${i}`, `ns${i}`, `host${i % 3}`)
    )));
    const counts = {
      token: 0,
      readiness: 0,
      mcp: { initialize: 0, initialized: 0, toolsList: 0, promptsList: 0, promptsGet: 0 },
    };
    installRealChainFetch({ counts });
    const registry = createModuleToolRegistry();
    const identity = listingIdentity(sites.map((site) => site._name));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = performance.now();
      const cold = await registry.list({
        sites, identity, waitMs: 20_000, logPending: false,
      });
      const coldMs = performance.now() - started;
      expect(cold).toHaveLength(13);
      expect(coldMs).toBeGreaterThan(7_000);
      expect(coldMs).toBeLessThan(20_000);
      const line = `[DEV-1019] real-chain unnotified first list: ${Math.round(coldMs)}ms tools=${cold.length}`;
      console.error(line);
      process.stdout.write(`${line}\n`);
    } finally {
      stderr.mockRestore();
    }
  }, 30_000);
});
