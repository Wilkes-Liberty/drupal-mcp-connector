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
import { getSiteConfig, listSiteNames } from "../../src/lib/config.js";
import { securityMiddleware, callTool, listResolvableSiteConfigs } from "../../src/lib/dispatch.js";
import { GovernanceError, clearGovernanceCache } from "../../src/lib/governance.js";
import { SecurityError } from "../../src/lib/security.js";
import { withResolvedTarget } from "../../src/lib/site-target.js";
import {
  HEADER_DECLARED_DESTINATION,
  REASON_CHAINED_ACTION,
  getDataFlowContext,
  northboundHeaders,
  resetDataFlowBudgets,
} from "../../src/lib/data-flow.js";

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
  resetDataFlowBudgets();
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

describe("resolved target echo (#167)", () => {
  it("names the default site and source:default when site is omitted on a multi-site config", async () => {
    const result = await callTool("drupal_mcp_whoami", {});
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload._target).toEqual({
      name: "open",
      baseUrl: "https://open.example.com",
      source: "default",
    });
    expect(payload.target).toEqual(payload._target);
  });

  it("keeps whoami.target.source aligned with _target when identity defaults the site", async () => {
    vi.mocked(fetch).mockResolvedValue(ready());
    const writer = {
      sub: "reader",
      clientId: "content-agent",
      scopes: ["mcp_read", "mcp_write"],
      sites: null,
    };
    const entitled = [
      { _name: "gov", baseUrl: "https://gov.example.com", requireGovernance: true, security: { preset: "development" } },
      { _name: "open", baseUrl: "https://open.example.com", security: { preset: "development" } },
    ];
    const result = await callTool(
      "drupal_mcp_whoami",
      {},
      { identity: writer, sites: entitled, grants: null, defaultSite: "gov" },
    );
    const payload = JSON.parse(result.content[0].text);
    expect(payload.target.source).toBe("default");
    expect(payload._target.source).toBe("default");
    expect(payload.target).toEqual(payload._target);
    expect(payload.site).toBe("gov");
  });

  it("reports source:hint when the caller passed site", async () => {
    const result = await callTool("drupal_mcp_whoami", { site: "open" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload._target).toEqual({
      name: "open",
      baseUrl: "https://open.example.com",
      source: "hint",
    });
  });

  it("echoes _target on a list_nodes-shaped payload when site is omitted", async () => {
    const handler = vi.fn(async () => ({
      total: 1,
      nodes: [{ id: "n1", title: "Private Infrastructure", _backend: "jsonapi" }],
    }));
    const ctx = {};
    const raw = await securityMiddleware(
      "drupal_list_nodes",
      { type: "solution", limit: 1 },
      handler,
      ctx,
    );
    const payload = withResolvedTarget(raw, ctx.resolvedTarget);
    expect(payload._target).toEqual({
      name: "open",
      baseUrl: "https://open.example.com",
      source: "default",
    });
    expect(payload.nodes[0]._backend).toBe("jsonapi");
    expect(payload.nodes[0]).not.toHaveProperty("_target");
  });

  it("does not invent a single _target for list_sites", async () => {
    const result = await callTool("drupal_list_sites", {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload._target).toBeUndefined();
    expect(payload.sites).toEqual(expect.arrayContaining(["gov", "open"]));
  });

  it("refuses a write that omitted site when more than one site is configured", async () => {
    const handler = vi.fn();
    await expect(
      securityMiddleware("drupal_create_node", { type: "article", title: "T" }, handler),
    ).rejects.toBeInstanceOf(SecurityError);
    expect(handler).not.toHaveBeenCalled();

    const result = await callTool("drupal_create_node", { type: "article", title: "T" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Access denied:.*explicit site/s);
    expect(result.content[0].text).toContain("open");
    expect(result.content[0].text).toContain("https://open.example.com");
  });

  it("refuses a GraphQL mutation that omitted site on a multi-site config", async () => {
    const handler = vi.fn();
    await expect(securityMiddleware(
      "drupal_graphql",
      { query: "mutation { createNode { id } }" },
      handler,
    )).rejects.toThrow(/explicit site/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows a write that omitted site when only one site is configured", async () => {
    vi.mocked(listSiteNames).mockReturnValueOnce(["open"]);
    const handler = vi.fn(async () => ({ id: "n1" }));
    await expect(
      securityMiddleware("drupal_create_node", { type: "article", title: "T" }, handler),
    ).resolves.toEqual({ id: "n1" });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("securityMiddleware northbound data-flow (#179)", () => {
  const reader = {
    sub: "alice",
    clientId: "content-agent",
    scopes: ["mcp_read"],
    sites: null,
  };
  const tightGov = {
    _name: "gov",
    baseUrl: "https://gov.example.com",
    requireGovernance: true,
    security: {
      preset: "development",
      allowDestructive: true,
      declaredCeiling: "internal",
      readBudgets: {
        chainedActions: 1,
        chainedActionWindowSec: 60,
        requests: 2,
        requestWindowSec: 60,
        pages: 2,
        pageWindowSec: 60,
        results: 5,
        bytes: 1024,
      },
    },
  };

  it("binds principal and target onto the request and sends declared destination", async () => {
    vi.mocked(fetch).mockResolvedValue(ready());
    vi.mocked(getSiteConfig).mockReturnValue(tightGov);
    const handler = vi.fn(async () => {
      const flow = getDataFlowContext();
      expect(flow.principalKey).toBe("alice:content-agent");
      expect(flow.targetName).toBe("gov");
      expect(flow.enforce).toBe(true);
      expect(northboundHeaders()[HEADER_DECLARED_DESTINATION]).toBe("content-agent:gov");
      return { ok: true };
    });
    await securityMiddleware(
      "drupal_get_node",
      { site: "gov", id: "1" },
      handler,
      { identity: reader, sites: [tightGov], grants: null, defaultSite: "gov" },
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it("exhausts chained actions for one principal without leaking payload", async () => {
    vi.mocked(fetch).mockResolvedValue(ready());
    vi.mocked(getSiteConfig).mockReturnValue(tightGov);
    const handler = vi.fn(async () => ({ secret: "restricted-body" }));
    const ctx = { identity: reader, sites: [tightGov], grants: null, defaultSite: "gov" };
    await expect(
      securityMiddleware("drupal_get_node", { site: "gov", id: "1" }, handler, ctx),
    ).resolves.toEqual({ secret: "restricted-body" });
    const denied = await callTool(
      "drupal_get_node",
      { site: "gov", id: "2" },
      ctx,
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain(REASON_CHAINED_ACTION);
    expect(denied.content[0].text).toMatch(/correlation /);
    expect(denied.content[0].text).not.toContain("restricted-body");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not burn a chained-action slot when source governance fails", async () => {
    vi.mocked(fetch).mockResolvedValue(notReady());
    vi.mocked(getSiteConfig).mockReturnValue(tightGov);
    const handler = vi.fn(async () => ({ ok: true }));
    const ctx = { identity: reader, sites: [tightGov], grants: null, defaultSite: "gov" };
    await expect(
      securityMiddleware("drupal_get_node", { site: "gov", id: "1" }, handler, ctx),
    ).rejects.toBeInstanceOf(GovernanceError);
    expect(handler).not.toHaveBeenCalled();

    clearGovernanceCache();
    vi.mocked(fetch).mockResolvedValue(ready());
    await expect(
      securityMiddleware("drupal_get_node", { site: "gov", id: "1" }, handler, ctx),
    ).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not consume a chained-action slot for list_sites", async () => {
    const handler = vi.fn(async () => ({ sites: ["gov"] }));
    await securityMiddleware(
      "drupal_list_sites",
      {},
      handler,
      { identity: reader, sites: [tightGov], grants: null },
    );
    expect(getDataFlowContext()).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
  });
});
