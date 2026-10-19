/**
 * DEV-1019 listing budget: hanging source-governance must not stall
 * tools/list or prompts/list past the wait, and malformed identities
 * cannot share a cache bucket.
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
import { createModuleToolRegistry } from "../../src/lib/module-tools.js";
import { clearCatalogNotifications } from "../../src/lib/catalog-notify.js";
import {
  catalogListWaitMs,
  clearSiteCatalogCache,
  getCatalogDiscoveryOptions,
  MAX_LIST_WAIT_MS,
} from "../../src/lib/site-catalog.js";
import { abortCatalogWork, resetCatalogShutdown } from "../../src/lib/catalog-signal.js";
import { clearGovernanceCache } from "../../src/lib/governance.js";
import { moduleWorkflowProvidersWithRemote } from "../../src/lib/workflow-prompts.js";

const schema = {
  type: "object", required: ["id"], additionalProperties: false,
  properties: { id: { type: "integer", minimum: 1 } },
};

function moduleSite(name, namespace) {
  return {
    _name: name,
    baseUrl: `https://${name}.example.com`,
    requireGovernance: true,
    apiToken: "tok-secret",
    security: { preset: "development", readOnly: false },
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

function hangingFetch(_url, opts) {
  return new Promise((resolve) => {
    const done = () => resolve({
      ok: false,
      status: 0,
      headers: { get: () => null },
      json: async () => {
        throw new Error("aborted");
      },
      text: async () => "",
    });
    if (opts?.signal?.aborted) {
      done();
      return;
    }
    opts?.signal?.addEventListener("abort", done, { once: true });
  });
}

function readyFetch() {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ contract_ready: true, reason: null, scope: "source_governance_contract" }),
    text: async () => "",
  });
}

function hangingEstate(count) {
  return Array.from({ length: count }, (_, i) => moduleSite(`warm${i}`, `warm${i}_ns`));
}

beforeEach(() => {
  clearSiteCatalogCache();
  clearCatalogNotifications();
  clearGovernanceCache();
  state.sites = [];
  vi.mocked(fetch).mockReset();
  vi.mocked(fetch).mockImplementation(hangingFetch);
});

afterEach(() => {
  abortCatalogWork();
  resetCatalogShutdown();
  delete process.env.MCP_CATALOG_UNNOTIFIED_LIST_WAIT_MS;
  delete process.env.MCP_CATALOG_SITE_DEADLINE_MS;
});

describe("DEV-1019 listing budget against hanging governance", () => {
  it("returns tools/list within the wait budget and omits the hanging site", async () => {
    const site = moduleSite("hang", "hang_ns");
    state.sites = [site];
    const list = vi.fn(async () => ({ tools: [{ name: "tool_api.item", inputSchema: schema }] }));
    const registry = createModuleToolRegistry({ list });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = performance.now();
      const definitions = await registry.list({
        sites: [site],
        identity: listingIdentity(["hang"]),
        waitMs: 2000,
        logPending: false,
      });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(4_000);
      expect(elapsed).toBeLessThan(MAX_LIST_WAIT_MS);
      expect(definitions).toEqual([]);
      expect(list).not.toHaveBeenCalled();
      const line = `[DEV-1019] hanging governance tools/list=${Math.round(elapsed)}ms`;
      console.error(line);
      process.stdout.write(`${line}\n`);
    } finally {
      stderr.mockRestore();
    }
  }, 40_000);

  it("returns prompts/list within the wait budget and omits the hanging site", async () => {
    const site = moduleSite("hangp", "hangp_ns");
    state.sites = [site];
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = performance.now();
      const providers = await moduleWorkflowProvidersWithRemote([site], {
        identity: listingIdentity(["hangp"]),
        list: async () => ({ tools: [{ name: "tool_api.item", inputSchema: schema }] }),
        fetch: async () => ({ list: [], bodies: new Map() }),
        waitMs: 2000,
      });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(4_000);
      expect(elapsed).toBeLessThan(MAX_LIST_WAIT_MS);
      expect(providers).toEqual([]);
      const line = `[DEV-1019] hanging governance prompts/list=${Math.round(elapsed)}ms`;
      console.error(line);
      process.stdout.write(`${line}\n`);
    } finally {
      stderr.mockRestore();
    }
  }, 40_000);

  it("clamps a 60s unnotified wait and keeps hanging listing under that cap", async () => {
    process.env.MCP_CATALOG_UNNOTIFIED_LIST_WAIT_MS = "60000";
    expect(getCatalogDiscoveryOptions().unnotifiedListWaitMs).toBe(MAX_LIST_WAIT_MS);
    expect(catalogListWaitMs()).toBe(MAX_LIST_WAIT_MS);
    const site = moduleSite("cap", "cap_ns");
    state.sites = [site];
    const registry = createModuleToolRegistry({
      list: async () => ({ tools: [{ name: "tool_api.item", inputSchema: schema }] }),
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = performance.now();
      const definitions = await registry.list({
        sites: [site],
        identity: listingIdentity(["cap"]),
        waitMs: 2000,
        logPending: false,
      });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(4_000);
      expect(elapsed).toBeLessThan(MAX_LIST_WAIT_MS);
      expect(definitions).toEqual([]);
      const line = `[DEV-1019] hanging governance cap wall=${Math.round(elapsed)}ms clampedWait=${catalogListWaitMs()}`;
      console.error(line);
      process.stdout.write(`${line}\n`);
    } finally {
      stderr.mockRestore();
    }
  }, 40_000);

  it("keeps a warm-catalog tools/list near 4s when multiple sites hang after governance expires", async () => {
    const sites = hangingEstate(3);
    state.sites = sites;
    vi.mocked(fetch).mockImplementation(readyFetch);
    const list = vi.fn(async () => ({ tools: [{ name: "tool_api.item", inputSchema: schema }] }));
    const registry = createModuleToolRegistry({ list });
    const ctx = {
      sites,
      identity: listingIdentity(sites.map((site) => site._name)),
      waitMs: 20_000,
      logPending: false,
    };
    expect(await registry.list(ctx)).toHaveLength(3);
    clearGovernanceCache();
    vi.mocked(fetch).mockImplementation(hangingFetch);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = performance.now();
      const definitions = await registry.list(ctx);
      const elapsed = performance.now() - started;
      expect(definitions).toEqual([]);
      expect(elapsed).toBeGreaterThan(3_000);
      expect(elapsed).toBeLessThan(6_500);
      expect(elapsed).toBeLessThan(MAX_LIST_WAIT_MS);
      const line = `[DEV-1019] warm-catalog hanging tools/list=${Math.round(elapsed)}ms sites=${sites.length}`;
      console.error(line);
      process.stdout.write(`${line}\n`);
    } finally {
      stderr.mockRestore();
    }
  }, 15_000);

  it("keeps a warm-catalog prompts/list near 4s when multiple sites hang after governance expires", async () => {
    const sites = hangingEstate(3);
    state.sites = sites;
    vi.mocked(fetch).mockImplementation(readyFetch);
    const identity = listingIdentity(sites.map((site) => site._name));
    const list = async () => ({ tools: [{ name: "tool_api.item", inputSchema: schema }] });
    const fetchPrompts = async () => ({ list: [], bodies: new Map() });
    expect(await moduleWorkflowProvidersWithRemote(sites, {
      identity, list, fetch: fetchPrompts, waitMs: 20_000,
    })).toHaveLength(3);
    clearGovernanceCache();
    vi.mocked(fetch).mockImplementation(hangingFetch);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = performance.now();
      const providers = await moduleWorkflowProvidersWithRemote(sites, {
        identity, list, fetch: fetchPrompts, waitMs: 20_000,
      });
      const elapsed = performance.now() - started;
      expect(providers).toEqual([]);
      expect(elapsed).toBeGreaterThan(3_000);
      expect(elapsed).toBeLessThan(6_500);
      expect(elapsed).toBeLessThan(MAX_LIST_WAIT_MS);
      const line = `[DEV-1019] warm-catalog hanging prompts/list=${Math.round(elapsed)}ms sites=${sites.length}`;
      console.error(line);
      process.stdout.write(`${line}\n`);
    } finally {
      stderr.mockRestore();
    }
  }, 15_000);
});
