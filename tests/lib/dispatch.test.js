import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
vi.mock("../../src/lib/config.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    listSiteNames: vi.fn(() => ["gov", "open", "prod-admin"]),
    getSiteConfig: vi.fn((name) => {
      if (name === "prod-admin") {
        throw new Error('Site "prod-admin": requireSecureAuth is set but no Bearer apiToken or OAuth2 client credentials are configured');
      }
      if (name === "gov" || name === "gov-ro") {
        return {
          _name: name,
          baseUrl: "https://gov.example.com",
          apiToken: "tok-secret-value",
          requireGovernance: true,
          security: name === "gov-ro"
            ? { readOnly: true }
            : { preset: "development", allowDestructive: true },
        };
      }
      return {
        _name: name || "open",
        baseUrl: "https://open.example.com",
        security: { preset: "development" },
      };
    }),
  };
});

import fetch from "node-fetch";
import { getSiteConfig } from "../../src/lib/config.js";
import { securityMiddleware, callTool, listResolvableSiteConfigs } from "../../src/lib/dispatch.js";
import { GovernanceError, clearGovernanceCache } from "../../src/lib/governance.js";
import { SecurityError } from "../../src/lib/security.js";

const ready = () => ({
  ok: true,
  status: 200,
  json: async () => ({ contract_ready: true, reason: null }),
});
const notReady = (reason = "no_designated_consumer") => ({
  ok: false,
  status: 503,
  json: async () => ({ contract_ready: false, reason }),
});

beforeEach(() => {
  vi.mocked(fetch).mockReset();
  clearGovernanceCache();
});

// Every governed product path — JSON:API-backed entity writes and reads,
// GraphQL, the governed server-tool bridge, and the drush bridge — flows
// through this middleware, so denial here is denial on every backend with no
// ungoverned fallback left to reach.
const GOVERNED_PATHS = [
  ["drupal_create_node", { site: "gov", contentType: "article", title: "T" }],
  ["drupal_get_node", { site: "gov", id: "1" }],
  ["drupal_delete_node", { site: "gov", id: "1" }],
  ["drupal_graphql", { site: "gov", query: "{ nodeArticles { nodes { id } } }" }],
  ["drupal_config_set", { site: "gov", name: "system.site", values: {} }],
  ["drupal_drush_status", { site: "gov" }],
];

describe("securityMiddleware source-governance gate", () => {
  it.each(GOVERNED_PATHS)(
    "denies %s when the source contract is not ready, without invoking the handler",
    async (toolName, args) => {
      vi.mocked(fetch).mockResolvedValue(notReady());
      const handler = vi.fn(async () => ({ ok: true }));
      await expect(securityMiddleware(toolName, args, handler)).rejects.toBeInstanceOf(GovernanceError);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(GOVERNED_PATHS)(
    "denies %s on a source-governance outage, without invoking the handler",
    async (toolName, args) => {
      vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));
      const handler = vi.fn(async () => ({ ok: true }));
      await expect(securityMiddleware(toolName, args, handler)).rejects.toMatchObject({
        reason: "sentinel_unreachable",
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("denies when source governance is missing entirely (endpoint absent)", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const handler = vi.fn();
    await expect(
      securityMiddleware("drupal_create_node", { site: "gov", title: "T" }, handler),
    ).rejects.toMatchObject({ reason: "sentinel_unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches normally when the governed source verifies", async () => {
    vi.mocked(fetch).mockResolvedValue(ready());
    const handler = vi.fn(async () => ({ ok: true }));
    await expect(
      securityMiddleware("drupal_get_node", { site: "gov", id: "1" }, handler),
    ).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps the existing security assertions after a passing verification", async () => {
    vi.mocked(fetch).mockResolvedValue(ready());
    const handler = vi.fn();
    await expect(
      securityMiddleware("drupal_create_node", { site: "gov-ro", contentType: "article", title: "T" }, handler),
    ).rejects.toBeInstanceOf(SecurityError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves ungoverned sites entirely alone (no readiness traffic)", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    await securityMiddleware("drupal_create_node", { site: "open", title: "T" }, handler);
    expect(handler).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("exempts the governance diagnostic tool so operators can see what failed", async () => {
    vi.mocked(fetch).mockResolvedValue(notReady());
    const handler = vi.fn(async () => ({ sites: [] }));
    await expect(
      securityMiddleware("drupal_governance_status", { site: "gov" }, handler),
    ).resolves.toEqual({ sites: [] });
  });
});

describe("callTool governance envelope", () => {
  it("returns a diagnostic isError envelope naming the failed condition, without secrets", async () => {
    vi.mocked(fetch).mockResolvedValue(notReady("no_designated_consumer"));
    const result = await callTool("drupal_get_node", { site: "gov", id: "1" });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("Source governance");
    expect(text).toContain("no_designated_consumer");
    expect(text).not.toContain("tok-secret-value");
  });
});

describe("securityMiddleware inbound entitlement (#178)", () => {
  const granted = [{
    _name: "gov",
    baseUrl: "https://gov.example.com",
    requireGovernance: true,
    security: { preset: "development", allowDestructive: true },
  }];
  const reader = {
    sub: "reader",
    clientId: "content-agent",
    scopes: ["mcp_read"],
    sites: null,
  };

  it("denies an unauthorized write without invoking the handler", async () => {
    const handler = vi.fn();
    await expect(securityMiddleware(
      "drupal_create_node",
      { site: "gov", title: "T" },
      handler,
      { identity: reader, sites: granted, grants: null, defaultSite: "gov" },
    )).rejects.toBeInstanceOf(SecurityError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns an Access denied envelope for a hidden tool that is called anyway", async () => {
    const result = await callTool(
      "drupal_create_node",
      { site: "gov", title: "T" },
      { identity: reader, sites: granted, grants: null, defaultSite: "gov" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Access denied: Not entitled to invoke/);
  });

  it("does not resolve the default site for an unscoped governance_status", async () => {
    vi.mocked(getSiteConfig).mockClear();
    const handler = vi.fn(async () => ({ sites: [] }));
    await expect(securityMiddleware(
      "drupal_governance_status",
      {},
      handler,
      {
        identity: reader,
        sites: granted,
        grants: { "content-agent": ["gov"] },
        defaultSite: "prod-admin",
      },
    )).resolves.toEqual({ sites: [] });
    expect(handler).toHaveBeenCalledOnce();
    expect(getSiteConfig).not.toHaveBeenCalled();
  });

  it("rewrites a granted call onto the authoritative site name", async () => {
    vi.mocked(fetch).mockResolvedValue(ready());
    const handler = vi.fn(async (args) => args);
    const out = await securityMiddleware(
      "drupal_get_node",
      { site: "gov", id: "1" },
      handler,
      { identity: reader, sites: granted, grants: null, defaultSite: "gov" },
    );
    expect(out.site).toBe("gov");
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("listResolvableSiteConfigs", () => {
  it("skips sites whose resolution throws, so one inert site cannot kill discovery", () => {
    // prod-admin is the deliberately credential-less break-glass site: its
    // Keychain item is kept absent on purpose, so resolution throws. That must
    // exclude it from the discovery pool, never break tools/list (2.4.0 bug).
    const sites = listResolvableSiteConfigs();
    expect(sites.map((s) => s._name)).toEqual(["gov", "open"]);
  });
});
