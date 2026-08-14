import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("node-fetch", () => ({ default: vi.fn() }));
import fetch from "node-fetch";
import {
  GovernanceError,
  requiresGovernance,
  verifySourceGovernance,
  assertSourceGovernance,
  governanceStatus,
  clearGovernanceCache,
  filterDiscoverableTools,
  OK_TTL_MS,
} from "../../src/lib/governance.js";

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

beforeEach(() => {
  vi.mocked(fetch).mockReset();
  clearGovernanceCache();
});
afterEach(() => {
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
    vi.mocked(fetch).mockResolvedValueOnce(notReady("no_designated_consumer"));
    const status = await governanceStatus([governedSite(), openSite()]);
    const gov = status.find((s) => s.site === "gov");
    const open = status.find((s) => s.site === "open");
    expect(gov).toMatchObject({ required: true, ok: false, reason: "no_designated_consumer" });
    expect(open).toMatchObject({ required: false, ok: true });
    expect(JSON.stringify(status)).not.toContain("tok-secret-value");
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
