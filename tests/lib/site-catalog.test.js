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
vi.mock("../../src/lib/governance.js", async (original) => ({
  ...await original(),
  assertSourceGovernance: vi.fn(async () => {}),
  listingSourceGovernanceAllows: vi.fn(async () => true),
  listingSourceGovernanceAllowsSites: vi.fn(async (sites) => {
    const allowed = new Map();
    for (const site of sites ?? []) {
      const name = site?._name ?? site?.baseUrl;
      if (name) allowed.set(name, true);
    }
    return allowed;
  }),
}));
import fetch from "node-fetch";
import {
  assertSourceGovernance,
  listingSourceGovernanceAllows,
  listingSourceGovernanceAllowsSites,
} from "../../src/lib/governance.js";
import { createModuleToolRegistry } from "../../src/lib/module-tools.js";
import { subscribeCatalogNotifications, clearCatalogNotifications } from "../../src/lib/catalog-notify.js";
import {
  CATALOG_LIST_BUDGET_MS,
  catalogListWaitMs,
  catalogPrincipalKey,
  clearSiteCatalogCache,
  DEFAULT_UNNOTIFIED_LIST_WAIT_MS,
  getCatalogDiscoveryOptions,
  remainingCatalogListBudgetMs,
  invalidateSiteCatalogsForSite,
  loadSiteCatalog,
  mapSitesBounded,
  MAX_LIST_WAIT_MS,
  prefetchSiteCatalogs,
  workflowIdsFromSite,
} from "../../src/lib/site-catalog.js";
import {
  CATALOG_NOTIFY_DEBOUNCE_MS,
  noteInboundCatalogSessionMessage,
  registerLiveCatalogServer,
} from "../../src/lib/catalog-notify.js";
import {
  clearGovernanceCache,
  filterDiscoverableTools,
} from "../../src/lib/governance.js";
import { moduleWorkflowProvidersWithRemote } from "../../src/lib/workflow-prompts.js";

const schema = {
  type: "object", required: ["id"], additionalProperties: false,
  properties: { id: { type: "integer", minimum: 1 } },
};
const remote = (name) => ({ name, inputSchema: schema, outputSchema: schema });
const rule = (name, operation = "read") => ({
  name, operation, scope: "module_access", capabilities: [],
});

function moduleSite(name, namespace, extra = {}) {
  return {
    _name: name,
    baseUrl: `https://${name}.example.com`,
    requireGovernance: true,
    security: { preset: "development", readOnly: false },
    serverTools: {
      url: "/mcp",
      modules: {
        namespace,
        tools: { item: rule("tool_api.item") },
        ...extra,
      },
    },
  };
}

function useSites(sites) {
  state.sites = sites;
  return sites;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  clearSiteCatalogCache();
  clearCatalogNotifications();
  clearGovernanceCache();
  state.sites = [];
  vi.mocked(fetch).mockReset();
  vi.mocked(assertSourceGovernance).mockResolvedValue();
  vi.mocked(listingSourceGovernanceAllows).mockResolvedValue(true);
  vi.mocked(listingSourceGovernanceAllowsSites).mockImplementation(async (sites) => {
    const allowed = new Map();
    for (const site of sites ?? []) {
      const name = site?._name ?? site?.baseUrl;
      if (name) allowed.set(name, true);
    }
    return allowed;
  });
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.MCP_CATALOG_SITE_DEADLINE_MS;
  delete process.env.MCP_CATALOG_UNNOTIFIED_LIST_WAIT_MS;
  delete process.env.MCP_CATALOG_CACHE_TTL_MS;
  delete process.env.MCP_CATALOG_NEGATIVE_TTL_MS;
  delete process.env.MCP_CATALOG_CONCURRENCY;
});

describe("getCatalogDiscoveryOptions", () => {
  it("reads env overrides over defaults", () => {
    process.env.MCP_CATALOG_SITE_DEADLINE_MS = "2500";
    process.env.MCP_CATALOG_UNNOTIFIED_LIST_WAIT_MS = "18000";
    process.env.MCP_CATALOG_CACHE_TTL_MS = "12000";
    process.env.MCP_CATALOG_NEGATIVE_TTL_MS = "3000";
    process.env.MCP_CATALOG_CONCURRENCY = "32";
    expect(getCatalogDiscoveryOptions({})).toMatchObject({
      siteDeadlineMs: 2500,
      unnotifiedListWaitMs: 18000,
      cacheTtlMs: 12000,
      negativeTtlMs: 3000,
      concurrency: 32,
    });
  });

  it("ignores non-positive values", () => {
    expect(getCatalogDiscoveryOptions({ siteDeadlineMs: 0, concurrency: -1, negativeTtlMs: 0 })).toMatchObject({
      siteDeadlineMs: 4000,
      unnotifiedListWaitMs: DEFAULT_UNNOTIFIED_LIST_WAIT_MS,
      cacheTtlMs: 600_000,
      negativeTtlMs: 5_000,
      concurrency: 16,
    });
  });

  it("uses the unnotified wait unless list_changed can reach this session", () => {
    const modern = { getNegotiatedProtocolVersion: () => "2026-07-28" };
    const legacy = { getNegotiatedProtocolVersion: () => "2025-11-25" };
    expect(catalogListWaitMs()).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    expect(catalogListWaitMs(modern)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    expect(catalogListWaitMs(legacy)).toBe(4000);
    registerLiveCatalogServer(modern);
    noteInboundCatalogSessionMessage({ method: "initialize", params: { protocolVersion: "2026-07-28" } }, modern);
    expect(catalogListWaitMs(modern)).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
    noteInboundCatalogSessionMessage({
      method: "subscriptions/listen",
      id: 3,
      params: { notifications: { toolsListChanged: true } },
    }, modern);
    expect(catalogListWaitMs(modern)).toBe(4000);
    expect(catalogListWaitMs()).toBe(DEFAULT_UNNOTIFIED_LIST_WAIT_MS);
  });

  it("clamps listing waits so catalog plus governance stay under 25s", () => {
    expect(getCatalogDiscoveryOptions({ unnotifiedListWaitMs: 60_000 }).unnotifiedListWaitMs)
      .toBe(MAX_LIST_WAIT_MS);
    expect(getCatalogDiscoveryOptions({ siteDeadlineMs: 60_000 }).siteDeadlineMs)
      .toBe(MAX_LIST_WAIT_MS);
    process.env.MCP_CATALOG_UNNOTIFIED_LIST_WAIT_MS = "60000";
    expect(catalogListWaitMs()).toBe(MAX_LIST_WAIT_MS);
  });

  it("computes the remaining listing budget for the governance re-check", () => {
    expect(remainingCatalogListBudgetMs(undefined, Date.now())).toBeUndefined();
    expect(remainingCatalogListBudgetMs(0, Date.now())).toBe(0);
    const started = Date.now();
    expect(remainingCatalogListBudgetMs(5_000, started)).toBeLessThanOrEqual(5_000);
    expect(remainingCatalogListBudgetMs(5_000, started)).toBeGreaterThan(4_000);
    expect(remainingCatalogListBudgetMs(60_000, started)).toBeLessThanOrEqual(MAX_LIST_WAIT_MS);
    expect(remainingCatalogListBudgetMs(60_000, started)).toBeGreaterThan(MAX_LIST_WAIT_MS - 50);
  });
});

describe("mapSitesBounded", () => {
  it("keeps input order and respects the concurrency cap", async () => {
    const seen = [];
    const inflight = { n: 0, max: 0 };
    const results = await mapSitesBounded([1, 2, 3, 4], 2, async (item) => {
      inflight.n += 1;
      inflight.max = Math.max(inflight.max, inflight.n);
      seen.push(item);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inflight.n -= 1;
      return item * 10;
    });
    expect(results).toEqual([10, 20, 30, 40]);
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
    expect(inflight.max).toBeLessThanOrEqual(2);
  });
});

describe("workflowIdsFromSite", () => {
  it("skips comment keys and uses an explicit id", () => {
    expect(workflowIdsFromSite({
      serverTools: { modules: { workflows: {
        _comment: { description: "no" },
        review: { id: "review_and_log", description: "yes" },
      } } },
    })).toEqual(["review_and_log"]);
  });
});

describe("DEV-1019 catalog listing", () => {
  it("returns tools on the first list when every site finishes inside the wait", async () => {
    const sites = useSites(Array.from({ length: 13 }, (_, i) => moduleSite(`fast${i}`, `ns${i}`)));
    const list = vi.fn(async () => ({ tools: [remote("tool_api.item")] }));
    const registry = createModuleToolRegistry({ list });
    const started = performance.now();
    const definitions = await registry.list({
      sites,
      identity: listingIdentity(sites.map((site) => site._name)),
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(CATALOG_LIST_BUDGET_MS);
    expect(definitions).toHaveLength(13);
  });

  it("omits a not-yet-ready site without aborting its chain", async () => {
    const slow = moduleSite("slow", "slow_ns");
    const fast = moduleSite("fast", "fast_ns");
    useSites([slow, fast]);
    let finishedSlow = false;
    let releaseSlow;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const list = vi.fn(async (site) => {
      if (site._name === "slow") {
        await slowGate;
        finishedSlow = true;
        return { tools: [remote("tool_api.item")] };
      }
      return { tools: [remote("tool_api.item")] };
    });
    const registry = createModuleToolRegistry({ list });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const definitions = await registry.list({
        sites: [slow, fast],
        identity: listingIdentity(["slow", "fast"]),
        siteDeadlineMs: 80,
      });
      expect(finishedSlow).toBe(false);
      expect(definitions.map((item) => item.name)).toEqual([
        "drupal_module_read_fast_ns__item",
      ]);
      const omit = stderr.mock.calls.map((args) => args.join(" ")).find((line) => line.includes("slow"));
      expect(omit).toMatch(/Catalog discovery omitted site "slow"/);
      expect(omit).toMatch(/not ready/);
      expect(omit).not.toMatch(/secret|token|Bearer/i);
      releaseSlow();
      await delay(20);
      expect(finishedSlow).toBe(true);
      const warmed = await registry.list({
        sites: [slow, fast],
        identity: listingIdentity(["slow", "fast"]),
        siteDeadlineMs: 80,
      });
      expect(warmed.map((item) => item.name).sort()).toEqual([
        "drupal_module_read_fast_ns__item",
        "drupal_module_read_slow_ns__item",
      ]);
    } finally {
      releaseSlow();
      stderr.mockRestore();
    }
  });

  it("omits an erroring site and never grants its tools", async () => {
    const bad = moduleSite("bad", "bad_ns");
    const ok = moduleSite("ok", "ok_ns");
    useSites([bad, ok]);
    const list = vi.fn(async (site) => {
      if (site._name === "bad") throw new Error("ECONNRESET token=sekrit");
      return { tools: [remote("tool_api.item")] };
    });
    const registry = createModuleToolRegistry({ list });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const definitions = await registry.list({
        sites: [bad, ok],
        identity: listingIdentity(["bad", "ok"]),
      });
      expect(definitions.map((item) => item.name)).toEqual([
        "drupal_module_read_ok_ns__item",
      ]);
      const omit = stderr.mock.calls.map((args) => args.join(" ")).find((line) => line.includes("bad"));
      expect(omit).toMatch(/omitted site "bad": source error/);
      expect(omit).not.toContain("sekrit");
      expect(omit).not.toContain("token=");
    } finally {
      stderr.mockRestore();
    }
  });

  it("hides governed tools when no site verifies (timeout)", async () => {
    vi.mocked(fetch).mockImplementation((_url, opts) => new Promise((_, reject) => {
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
      setTimeout(abort, 250);
    }));
    const defs = [
      { name: "drupal_list_sites" },
      { name: "drupal_governance_status" },
      { name: "drupal_create_node" },
      { name: "drupal_graphql" },
    ];
    const visible = await filterDiscoverableTools(defs, [
      { _name: "gov-a", baseUrl: "https://a.example.com", requireGovernance: true, apiToken: "tok-secret" },
      { _name: "gov-b", baseUrl: "https://b.example.com", requireGovernance: true, apiToken: "tok-secret" },
    ], { timeoutMs: 40 });
    expect(visible.map((item) => item.name)).toEqual([
      "drupal_list_sites",
      "drupal_governance_status",
    ]);
    expect(JSON.stringify(visible)).not.toContain("tok-secret");
  });

  it("shares one fetch between tools/list and prompts/list", async () => {
    const site = useSites([moduleSite("shared", "shared_ns", {
      workflows: {
        review: {
          description: "Review.",
          readOnly: true,
          tools: ["item"],
          instructions: "Call {tool:item}.",
        },
      },
    })])[0];
    const list = vi.fn(async () => ({ tools: [remote("tool_api.item")] }));
    const fetchPrompts = vi.fn(async () => ({
      list: [{ name: "review", description: "Remote." }],
      bodies: new Map([["review", {
        messages: [{ role: "user", content: { type: "text", text: "Call {tool:item}." } }],
      }]]),
    }));
    const registry = createModuleToolRegistry({ list });
    const ctx = {
      sites: [site],
      identity: listingIdentity(["shared"]),
      fetchPrompts,
    };
    const [tools, providers] = await Promise.all([
      registry.list(ctx),
      moduleWorkflowProvidersWithRemote([site], {
        identity: ctx.identity,
        list,
        fetch: fetchPrompts,
      }),
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(fetchPrompts).toHaveBeenCalledTimes(1);
    expect(tools).toHaveLength(1);
    expect(providers[0].workflows[0].description).toBe("Remote.");
  });

  it("invalidates the catalog cache on session expiry", async () => {
    const site = useSites([moduleSite("sess", "sess_ns")])[0];
    const list = vi.fn(async () => ({ tools: [remote("tool_api.item")] }));
    const registry = createModuleToolRegistry({ list });
    const ctx = { sites: [site], identity: listingIdentity(["sess"]) };
    expect(await registry.list(ctx)).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(1);
    invalidateSiteCatalogsForSite("sess", null);
    expect(await registry.list(ctx)).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("ignores an in-flight store after the catalog cache is cleared", async () => {
    const site = useSites([moduleSite("epoch", "epoch_ns")])[0];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const firstList = vi.fn(async () => {
      await gate;
      return { tools: [remote("tool_api.item")] };
    });
    const first = createModuleToolRegistry({ list: firstList }).list({
      sites: [site], identity: listingIdentity(["epoch"]), waitMs: 20, logPending: false,
    });
    while (firstList.mock.calls.length === 0) await delay(5);
    clearSiteCatalogCache();
    release();
    await first;
    const secondList = vi.fn(async () => ({ tools: [remote("tool_api.item")] }));
    const second = await createModuleToolRegistry({ list: secondList }).list({
      sites: [site], identity: listingIdentity(["epoch"]), waitMs: 200, logPending: false,
    });
    expect(secondList).toHaveBeenCalled();
    expect(second).toHaveLength(1);
  });

  it("does not start a second catalog walk when invalidate runs during an in-flight walk", async () => {
    const site = useSites([moduleSite("dup", "dup_ns")])[0];
    let walks = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const list = vi.fn(async () => {
      walks += 1;
      await gate;
      return { tools: [remote("tool_api.item")] };
    });
    const registry = createModuleToolRegistry({ list });
    const identity = listingIdentity(["dup"]);
    const first = registry.list({
      sites: [site], identity, waitMs: 50, logPending: false,
    });
    while (walks === 0) await delay(5);
    invalidateSiteCatalogsForSite("dup", null);
    const second = registry.list({
      sites: [site], identity, waitMs: 400, logPending: false,
    });
    await delay(40);
    expect(walks).toBe(1);
    release();
    await Promise.all([first, second]);
  });

  it("does not start prompt hops until source governance resolves", async () => {
    const site = useSites([moduleSite("hop", "hop_ns", {
      workflows: {
        review: {
          description: "Review.",
          readOnly: true,
          tools: ["item"],
          instructions: "Call {tool:item}.",
        },
      },
    })])[0];
    let releaseGov;
    const govGate = new Promise((resolve) => { releaseGov = resolve; });
    vi.mocked(assertSourceGovernance).mockImplementation(() => govGate);
    let promptsStarted = false;
    const fetchPrompts = vi.fn(async () => {
      promptsStarted = true;
      return { list: [], bodies: new Map() };
    });
    const list = vi.fn(async () => ({ tools: [remote("tool_api.item")] }));
    const registry = createModuleToolRegistry({ list });
    const pending = registry.list({
      sites: [site],
      identity: listingIdentity(["hop"]),
      fetchPrompts,
      waitMs: 500,
      logPending: false,
    });
    await delay(40);
    expect(promptsStarted).toBe(false);
    expect(list).not.toHaveBeenCalled();
    releaseGov();
    await pending;
    expect(promptsStarted).toBe(true);
  });

  it("does not share a catalog across principals", async () => {
    const site = useSites([moduleSite("iso", "iso_ns")])[0];
    const list = vi.fn(async () => ({ tools: [remote("tool_api.item")] }));
    const registry = createModuleToolRegistry({ list });
    const a = listingIdentity(["iso"]);
    const b = { ...listingIdentity(["iso"]), sub: "other-operator" };
    await Promise.all([
      registry.list({ sites: [site], identity: a }),
      registry.list({ sites: [site], identity: b }),
    ]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("emits list_changed when a background snapshot lands", async () => {
    const site = useSites([moduleSite("notify", "notify_ns")])[0];
    const events = [];
    const stop = subscribeCatalogNotifications((event) => events.push(event));
    const list = vi.fn(async () => {
      await delay(80);
      return { tools: [remote("tool_api.item")] };
    });
    const registry = createModuleToolRegistry({ list });
    const ctx = { sites: [site], identity: listingIdentity(["notify"]), siteDeadlineMs: 20 };
    try {
      expect(await registry.list(ctx)).toHaveLength(0);
      const started = Date.now();
      while (events.length === 0 && Date.now() - started < 1_000) {
        await delay(10);
      }
      await delay(CATALOG_NOTIFY_DEBOUNCE_MS + 20);
      expect(events.some((event) => event.tools)).toBe(true);
      expect(await registry.list(ctx)).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("serves a stale snapshot immediately while refreshing", async () => {
    const site = moduleSite("swr", "swr_ns");
    let n = 0;
    const work = vi.fn(async () => {
      n += 1;
      return {
        tools: new Map([[`rev-${n}`, { name: `rev-${n}` }]]),
        cache: true,
      };
    });
    const first = await loadSiteCatalog(site, { work, cacheTtlMs: 40, waitMs: 200 });
    expect(first.ok).toBe(true);
    expect(first.tools.has("rev-1")).toBe(true);
    await delay(50);
    const started = performance.now();
    const stale = await loadSiteCatalog(site, { work, cacheTtlMs: 40, waitMs: 200 });
    expect(performance.now() - started).toBeLessThan(30);
    expect(stale.tools.has("rev-1")).toBe(true);
    await delay(20);
    expect(n).toBe(2);
    const refreshed = await loadSiteCatalog(site, { work, cacheTtlMs: 40, waitMs: 200 });
    expect(refreshed.tools.has("rev-2")).toBe(true);
  });

  it("uses a short negative TTL so errors do not stampede", async () => {
    const site = moduleSite("neg", "neg_ns");
    const work = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await loadSiteCatalog(site, { work, negativeTtlMs: 200, waitMs: 200 });
      const second = await loadSiteCatalog(site, { work, negativeTtlMs: 200, waitMs: 200 });
      expect(first.ok).toBe(false);
      expect(second.ok).toBe(false);
      expect(work).toHaveBeenCalledTimes(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it("never treats a late snapshot for one principal as a grant to another", async () => {
    const site = moduleSite("leak", "leak_ns");
    const workA = vi.fn(async () => {
      await delay(80);
      return { tools: new Map([["secret", { name: "secret" }]]), cache: true };
    });
    const workB = vi.fn(async () => ({ tools: new Map(), cache: true }));
    const a = listingIdentity(["leak"]);
    const b = { ...listingIdentity(["leak"]), sub: "other-operator" };
    const coldA = await loadSiteCatalog(site, { identity: a, work: workA, waitMs: 15, logPending: false });
    expect(coldA.ok).toBe(false);
    const coldB = await loadSiteCatalog(site, { identity: b, work: workB, waitMs: 50, logPending: false });
    expect(coldB.tools.has("secret")).toBe(false);
    await delay(100);
    const warmA = await loadSiteCatalog(site, { identity: a, work: workA, waitMs: 50 });
    expect(warmA.tools.has("secret")).toBe(true);
    const warmB = await loadSiteCatalog(site, { identity: b, work: workB, waitMs: 50 });
    expect(warmB.tools.has("secret")).toBe(false);
  });

  it("prefetches without blocking and finishes the chain in the background", async () => {
    const site = moduleSite("pre", "pre_ns");
    let done = false;
    const work = vi.fn(async () => {
      await delay(40);
      done = true;
      return { tools: new Map([["t", { name: "t" }]]), cache: true };
    });
    const started = performance.now();
    prefetchSiteCatalogs([site], { work, waitMs: 0, logPending: false });
    expect(performance.now() - started).toBeLessThan(20);
    expect(done).toBe(false);
    await delay(80);
    expect(done).toBe(true);
    const snap = await loadSiteCatalog(site, { work, waitMs: 20 });
    expect(snap.ok).toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a stale governance verdict even when the catalog snapshot is still ok", async () => {
    const site = useSites([moduleSite("stale", "stale_ns", {
      workflows: {
        review: {
          description: "Local fallback.",
          readOnly: true,
          tools: ["item"],
          instructions: "Call {tool:item}.",
        },
      },
    })])[0];
    const list = vi.fn(async () => ({ tools: [remote("tool_api.item")] }));
    const fetchPrompts = vi.fn(async () => ({
      list: [{ name: "review", description: "Remote." }],
      bodies: new Map([["review", {
        messages: [{ role: "user", content: { type: "text", text: "Call {tool:item}." } }],
      }]]),
    }));
    const identity = listingIdentity(["stale"]);
    const first = await moduleWorkflowProvidersWithRemote([site], {
      identity, list, fetch: fetchPrompts, waitMs: 200,
    });
    expect(first[0].workflows[0].description).toBe("Remote.");
    vi.mocked(listingSourceGovernanceAllowsSites).mockImplementationOnce(async (sites) => {
      const allowed = new Map();
      for (const site of sites ?? []) {
        const name = site?._name ?? site?.baseUrl;
        if (name) allowed.set(name, false);
      }
      return allowed;
    });
    const second = await moduleWorkflowProvidersWithRemote([site], {
      identity, list, fetch: fetchPrompts, waitMs: 200,
    });
    expect(second).toEqual([]);
    expect(JSON.stringify(second)).not.toContain("Remote.");
  });

  it("does not cache malformed identities and advertises no module tools", async () => {
    const site = useSites([moduleSite("mal", "mal_ns")])[0];
    const list = vi.fn(async () => ({ tools: [remote("tool_api.item")] }));
    const registry = createModuleToolRegistry({ list });
    const missingIss = { sub: "operator-a", azp: "agent", scopes: ["module_access"], sites: ["mal"] };
    const missingSub = { iss: "https://idp.example/realms/agents", azp: "agent", scopes: ["module_access"], sites: ["mal"] };
    expect(catalogPrincipalKey(missingIss)).toBeNull();
    expect(catalogPrincipalKey(missingSub)).toBeNull();
    const [a, b] = await Promise.all([
      registry.list({ sites: [site], identity: missingIss, waitMs: 200 }),
      registry.list({ sites: [site], identity: missingSub, waitMs: 200 }),
    ]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    const good = await registry.list({
      sites: [site],
      identity: listingIdentity(["mal"]),
      waitMs: 200,
    });
    expect(good).toHaveLength(1);
  });

  it("waits for the in-flight chain when list_changed cannot reach the client", async () => {
    const site = useSites([moduleSite("wait", "wait_ns")])[0];
    const list = vi.fn(async () => {
      await delay(80);
      return { tools: [remote("tool_api.item")] };
    });
    const registry = createModuleToolRegistry({ list });
    const ctx = {
      sites: [site],
      identity: listingIdentity(["wait"]),
      waitMs: 500,
      logPending: false,
    };
    const started = performance.now();
    const definitions = await registry.list(ctx);
    expect(performance.now() - started).toBeGreaterThan(60);
    expect(definitions).toHaveLength(1);
  });
});
