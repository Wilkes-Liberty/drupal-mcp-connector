import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("node-fetch", () => ({ default: vi.fn() }));
import fetch from "node-fetch";
import {
  GovernanceError,
  requiresGovernance,
  verifySourceGovernance,
  assertSourceGovernance,
  listingSourceGovernanceAllows,
  listingSourceGovernanceAllowsSites,
  governanceStatus,
  clearGovernanceCache,
  filterDiscoverableTools,
  LISTING_READINESS_TIMEOUT_MS,
  OK_TTL_MS,
} from "../../src/lib/governance.js";
import {
  clearCatalogNotifications,
  subscribeCatalogNotifications,
} from "../../src/lib/catalog-notify.js";
import { abortCatalogWork, resetCatalogShutdown } from "../../src/lib/catalog-signal.js";

const governedSite = (over = {}) => ({
  _name: "gov",
  baseUrl: "https://gov.example.com",
  apiToken: "tok-secret-value",
  requireGovernance: true,
  ...over,
});
const openSite = (over = {}) => ({ _name: "open", baseUrl: "https://open.example.com", ...over });

const ready = () => ({
  ok: true,
  status: 200,
  json: async () => ({ contract_ready: true, reason: null, scope: "source_governance_contract" }),
});
const notReady = (reason = "no_designated_consumer") => ({
  ok: false,
  status: 503,
  json: async () => ({ contract_ready: false, reason }),
});
const httpStatus = (status) => ({ ok: false, status, json: async () => ({}) });

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

beforeEach(() => {
  vi.mocked(fetch).mockReset();
  clearGovernanceCache();
  clearCatalogNotifications();
});
afterEach(() => {
  abortCatalogWork();
  resetCatalogShutdown();
  vi.useRealTimers();
});

describe("requiresGovernance", () => {
  it("is true only for an explicit requireGovernance flag", () => {
    expect(requiresGovernance(governedSite())).toBe(true);
    expect(requiresGovernance(openSite())).toBe(false);
    expect(requiresGovernance(openSite({ requireGovernance: false }))).toBe(false);
  });
});

describe("verifySourceGovernance", () => {
  it("verifies against the readiness endpoint with the site's credentials", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ready());
    const result = await verifySourceGovernance(governedSite());
    expect(result.ok).toBe(true);
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://gov.example.com/drupal-mcp/readiness");
    expect(opts.headers.Authorization).toBe("Bearer tok-secret-value");
  });

  it("reports the server's own reason when the contract is not ready", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(notReady("no_designated_consumer"));
    const result = await verifySourceGovernance(governedSite());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_designated_consumer");
  });

  it("treats a 404 as source governance unavailable (module missing or too old)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(httpStatus(404));
    const result = await verifySourceGovernance(governedSite());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sentinel_unavailable");
  });

  it("treats 401/403 as not authorized for governance", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(httpStatus(403));
    const result = await verifySourceGovernance(governedSite());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_authorized_for_governance");
  });

  it("attaches an abort signal on the readiness GET", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ready());
    await verifySourceGovernance(governedSite({ _name: "gov-timeout" }));
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect(opts.method).toBe("GET");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats a hung readiness probe as unreachable", async () => {
    vi.mocked(fetch).mockImplementation(hangingFetch);
    const result = await verifySourceGovernance(governedSite({ _name: "gov-hang" }), { timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sentinel_unreachable");
  });

  it("treats a network failure as unreachable", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.1"));
    const result = await verifySourceGovernance(governedSite());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sentinel_unreachable");
  });

  it("reports credential acquisition failure distinctly from an unreachable source", async () => {
    // The OAuth token request is the FIRST fetch an oauth site makes; its
    // failure must not be blamed on Sentinel.
    vi.mocked(fetch).mockRejectedValueOnce(new Error("token endpoint down"));
    const site = governedSite({
      _name: "gov-oauth-fail",
      apiToken: undefined,
      oauth: { tokenUrl: "/oauth/token", clientId: "c", clientSecret: "s", grant: "client_credentials" },
    });
    const result = await verifySourceGovernance(site);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("credential_acquisition_failed");
  });

  it("does not emit tools list_changed on the first governance ok", async () => {
    const events = [];
    const stop = subscribeCatalogNotifications((event) => events.push(event));
    vi.mocked(fetch).mockResolvedValueOnce(ready());
    try {
      const result = await verifySourceGovernance(governedSite({ _name: "gov-first-ok" }));
      expect(result.ok).toBe(true);
      expect(events).toEqual([]);
    } finally {
      stop();
    }
  });

  it("shares one in-flight readiness probe across concurrent callers", async () => {
    let started = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return ready();
    });
    const site = governedSite({ _name: "gov-inflight" });
    const [a, b] = await Promise.all([
      verifySourceGovernance(site),
      verifySourceGovernance(site),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(started).toBe(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("caches a passing verification inside the TTL and re-verifies beyond it", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(ready());
    await verifySourceGovernance(governedSite());
    await verifySourceGovernance(governedSite());
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(OK_TTL_MS + 1);
    await verifySourceGovernance(governedSite());
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("does not let a failure linger: a later verify re-checks and can recover", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(notReady());
    const failed = await verifySourceGovernance(governedSite());
    expect(failed.ok).toBe(false);

    vi.mocked(fetch).mockResolvedValueOnce(ready());
    vi.advanceTimersByTime(OK_TTL_MS + 1);
    const recovered = await verifySourceGovernance(governedSite());
    expect(recovered.ok).toBe(true);
  });
});

describe("assertSourceGovernance", () => {
  it("is a no-op for a site that does not require governance", async () => {
    await assertSourceGovernance(openSite());
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("passes silently when the source contract is ready", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ready());
    await expect(assertSourceGovernance(governedSite())).resolves.toBeUndefined();
  });

  it("denies with a GovernanceError naming the failed condition, without secrets", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(notReady("no_designated_consumer"));
    let caught;
    try {
      await assertSourceGovernance(governedSite());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GovernanceError);
    expect(caught.reason).toBe("no_designated_consumer");
    expect(caught.message).toContain("no_designated_consumer");
    expect(caught.message).not.toContain("tok-secret-value");
  });

  it("denies when verification cannot be refreshed (stale + outage)", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(ready());
    await assertSourceGovernance(governedSite());

    vi.advanceTimersByTime(OK_TTL_MS + 1);
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ETIMEDOUT"));
    await expect(assertSourceGovernance(governedSite())).rejects.toMatchObject({
      reason: "sentinel_unreachable",
    });
  });
});

describe("governanceStatus", () => {
  it("reports per-site condition without exposing credentials", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(notReady("no_designated_consumer"))
      .mockResolvedValueOnce(ready());
    const status = await governanceStatus([governedSite(), openSite()]);
    const gov = status.find((s) => s.site === "gov");
    const open = status.find((s) => s.site === "open");
    expect(gov).toMatchObject({
      required: true, checked: true, ok: false, reason: "no_designated_consumer",
    });
    expect(open).toMatchObject({ required: false, checked: true, ok: true, reason: null });
    expect(typeof open.checkedAt).toBe("number");
    expect(JSON.stringify(status)).not.toContain("tok-secret-value");
  });

  it("probes readiness even when the client does not require governance (#208)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(notReady("designated_consumer_disabled"));
    const status = await governanceStatus([openSite({ _name: "dev" })]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://open.example.com/drupal-mcp/readiness");
    expect(status[0]).toMatchObject({
      site: "dev",
      required: false,
      checked: true,
      ok: false,
      reason: "designated_consumer_disabled",
    });
    expect(typeof status[0].checkedAt).toBe("number");
  });

  it("never reports ok:true when the readiness probe cannot complete (#208)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const status = await governanceStatus([openSite()]);
    expect(status[0]).toMatchObject({
      required: false, checked: true, ok: false, reason: "sentinel_unreachable",
    });
    expect(typeof status[0].checkedAt).toBe("number");
  });
});

describe("filterDiscoverableTools", () => {
  const defs = [
    { name: "drupal_list_sites" },
    { name: "drupal_governance_status" },
    { name: "drupal_create_node" },
    { name: "drupal_graphql" },
  ];

  it("hides governed tools when no site passes governance", async () => {
    vi.mocked(fetch).mockResolvedValue(notReady());
    const visible = await filterDiscoverableTools(defs, [governedSite()]);
    expect(visible.map((d) => d.name)).toEqual(["drupal_list_sites", "drupal_governance_status"]);
  });

  it("keeps the full surface when a governed site verifies", async () => {
    vi.mocked(fetch).mockResolvedValue(ready());
    const visible = await filterDiscoverableTools(defs, [governedSite()]);
    expect(visible).toHaveLength(defs.length);
  });

  it("keeps the full surface when any configured site is ungoverned", async () => {
    vi.mocked(fetch).mockResolvedValue(notReady());
    const visible = await filterDiscoverableTools(defs, [governedSite(), openSite()]);
    expect(visible).toHaveLength(defs.length);
  });
});

describe("listingSourceGovernanceAllows", () => {
  it("uses a cached verdict without joining a hanging probe", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(ready());
    await verifySourceGovernance(governedSite({ _name: "gov-cached" }));
    vi.mocked(fetch).mockImplementation(hangingFetch);
    const started = performance.now();
    await expect(listingSourceGovernanceAllows(governedSite({ _name: "gov-cached" }), { timeoutMs: 30 }))
      .resolves.toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("fails closed when a hanging probe does not resolve in the listing budget", async () => {
    vi.mocked(fetch).mockImplementation(hangingFetch);
    const started = performance.now();
    await expect(listingSourceGovernanceAllows(governedSite({ _name: "gov-list-hang" }), { timeoutMs: 40 }))
      .resolves.toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("listingSourceGovernanceAllowsSites", () => {
  it("checks hanging sites in parallel under one shared deadline", async () => {
    vi.mocked(fetch).mockImplementation(hangingFetch);
    const sites = [
      governedSite({ _name: "gov-a", baseUrl: "https://a.example.com" }),
      governedSite({ _name: "gov-b", baseUrl: "https://b.example.com" }),
      governedSite({ _name: "gov-c", baseUrl: "https://c.example.com" }),
    ];
    const started = performance.now();
    const allowed = await listingSourceGovernanceAllowsSites(sites, { timeoutMs: 50 });
    const elapsed = performance.now() - started;
    expect([...allowed.values()]).toEqual([false, false, false]);
    expect(elapsed).toBeLessThan(100);
    expect(elapsed).toBeLessThan(LISTING_READINESS_TIMEOUT_MS);
  });
});
