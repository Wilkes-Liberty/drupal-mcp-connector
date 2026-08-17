import { describe, expect, it } from "vitest";
import {
  assertPrincipalEntitlement,
  callerTargetHints,
  filterPromptsByPrincipal,
  filterResourcesByPrincipal,
  filterToolsByPrincipal,
  principalHasScope,
  principalMayUseTool,
  requiredScopeForTool,
  resolveAuthoritativeTarget,
  resolveGrantedSiteNames,
  runWithIdentity,
  getRequestIdentity,
  visibleSiteTargets,
} from "../../src/lib/principal.js";
import { SecurityError } from "../../src/lib/security.js";

const prod = {
  _name: "production",
  baseUrl: "https://drupal.example.com",
  requireGovernance: true,
  oauth: { scopes: ["mcp_read", "mcp_write"] },
  security: { preset: "content-editor" },
};
const staging = {
  _name: "staging",
  baseUrl: "https://drupal-staging.example.com",
  requireGovernance: true,
  oauth: { scopes: ["mcp_read", "mcp_write"] },
  security: { preset: "content-editor" },
};
const development = {
  _name: "development",
  baseUrl: "https://drupal.example.test",
  requireGovernance: true,
  oauth: { scopes: ["mcp_read", "mcp_write", "mcp_config"] },
  security: { preset: "config-editor" },
};
const breakGlass = {
  _name: "break-glass",
  baseUrl: "https://localhost:8443",
  oauth: { scopes: ["mcp_read", "mcp_write", "mcp_config", "mcp_admin"] },
  security: { preset: "development" },
  drushSsh: { rawSql: "governed" },
};

const sites = [prod, staging, development, breakGlass];
const names = sites.map((site) => site._name);

const identity = (over = {}) => ({
  sub: "agent-1",
  clientId: "content-agent",
  scopes: ["mcp_read", "mcp_write"],
  sites: null,
  ...over,
});

const defs = [
  { name: "drupal_list_sites" },
  { name: "drupal_governance_status" },
  { name: "drupal_get_node" },
  { name: "drupal_create_node" },
  { name: "drupal_entity_create" },
  { name: "drupal_config_get" },
  { name: "drupal_config_set" },
  { name: "drupal_graphql" },
  { name: "drupal_drush_sql_query" },
];

describe("requiredScopeForTool", () => {
  it("maps operations onto inbound scopes and special-cases entity writes", () => {
    expect(requiredScopeForTool("drupal_list_sites")).toBeNull();
    expect(requiredScopeForTool("drupal_get_node")).toBe("mcp_read");
    expect(requiredScopeForTool("drupal_create_node")).toBe("mcp_write");
    expect(requiredScopeForTool("drupal_entity_create")).toBe("mcp_write");
    expect(requiredScopeForTool("drupal_entity_delete")).toBe("mcp_write");
    expect(requiredScopeForTool("drupal_config_get")).toBe("mcp_config");
    expect(requiredScopeForTool("drupal_drush_config_export")).toBe("mcp_config");
    expect(requiredScopeForTool("drupal_drush_sql_query")).toBe("mcp_admin");
  });
});

describe("resolveGrantedSiteNames", () => {
  it("does not filter when there is no inbound principal", () => {
    expect(resolveGrantedSiteNames(null, names, null)).toEqual(names);
  });

  it("uses auth.grants for the inbound client and drops unknown names", () => {
    const grants = { "content-agent": ["production", "nope", "staging"] };
    expect(resolveGrantedSiteNames(identity(), names, grants))
      .toEqual(["production", "staging"]);
  });

  it("denies every site when a grant table exists but the client is absent", () => {
    const grants = { "other-agent": ["production"] };
    expect(resolveGrantedSiteNames(identity(), names, grants)).toEqual([]);
  });

  it("intersects a JWT sites claim with configured names when no grant table", () => {
    expect(resolveGrantedSiteNames(identity({ sites: ["staging", "ghost"] }), names, null))
      .toEqual(["staging"]);
  });
});

describe("filterToolsByPrincipal", () => {
  it("keeps the full surface for a local operator (no inbound identity)", () => {
    expect(filterToolsByPrincipal(defs, sites, null).map((d) => d.name))
      .toEqual(defs.map((d) => d.name));
  });

  it("hides write and config tools from a read-only principal", () => {
    const visible = filterToolsByPrincipal(
      defs,
      sites,
      identity({ scopes: ["mcp_read"] }),
      { "content-agent": ["production"] },
    ).map((d) => d.name);
    expect(visible).toEqual([
      "drupal_list_sites",
      "drupal_governance_status",
      "drupal_get_node",
    ]);
  });

  it("hides GraphQL and raw SQL on governed product presets", () => {
    const visible = filterToolsByPrincipal(
      defs,
      [prod, staging],
      identity(),
      { "content-agent": ["production", "staging"] },
    ).map((d) => d.name);
    expect(visible).not.toContain("drupal_graphql");
    expect(visible).not.toContain("drupal_drush_sql_query");
    expect(visible).toContain("drupal_create_node");
    expect(visible).not.toContain("drupal_config_set");
  });

  it("shows GraphQL only when an entitled site actually allows it", () => {
    const visible = filterToolsByPrincipal(
      defs,
      sites,
      identity({ clientId: "admin-agent", scopes: ["mcp_read"] }),
      { "admin-agent": ["break-glass"] },
    ).map((d) => d.name);
    expect(visible).toContain("drupal_graphql");
    expect(visible).not.toContain("drupal_drush_sql_query");
  });

  it("treats empty inbound scopes as no grants, not a wildcard", () => {
    const visible = filterToolsByPrincipal(
      defs,
      sites,
      identity({ scopes: [] }),
      null,
    ).map((d) => d.name);
    expect(visible).toEqual(["drupal_list_sites", "drupal_governance_status"]);
  });
});

describe("cross-target discovery and conflicting hints", () => {
  const grants = { "content-agent": ["production"] };

  it("does not advertise an ungranted target", () => {
    expect(resolveGrantedSiteNames(identity(), names, grants)).toEqual(["production"]);
  });

  it("denies a direct call against an ungranted site", () => {
    expect(() => assertPrincipalEntitlement({
      toolName: "drupal_get_node",
      args: { site: "staging" },
      identity: identity(),
      sites,
      grants,
    })).toThrow(SecurityError);
    expect(() => assertPrincipalEntitlement({
      toolName: "drupal_get_node",
      args: { site: "staging" },
      identity: identity(),
      sites,
      grants,
    })).toThrow(/Not entitled to the requested target/);
  });

  it("denies a hidden write even when the caller names an entitled site", () => {
    expect(principalMayUseTool(
      "drupal_create_node",
      identity({ scopes: ["mcp_read"] }),
      sites,
      grants,
    )).toBe(false);
    expect(() => assertPrincipalEntitlement({
      toolName: "drupal_create_node",
      args: { site: "production" },
      identity: identity({ scopes: ["mcp_read"] }),
      sites,
      grants,
    })).toThrow(/Not entitled to invoke drupal_create_node/);
  });

  it("refuses conflicting caller hints instead of picking one", () => {
    expect(callerTargetHints({ site: "production", tenant: "staging" }))
      .toEqual([
        { key: "site", value: "production" },
        { key: "tenant", value: "staging" },
      ]);
    expect(() => resolveAuthoritativeTarget(
      { site: "production", environment: "staging" },
      identity(),
      sites,
      { grants, defaultSite: "production" },
    )).toThrow(/Conflicting caller target hints/);
  });

  it("ignores a caller scope argument — it is not a grant", () => {
    expect(principalHasScope(identity({ scopes: ["mcp_read"] }), "mcp_write")).toBe(false);
    expect(principalMayUseTool(
      "drupal_create_node",
      identity({ scopes: ["mcp_read"] }),
      sites,
      grants,
    )).toBe(false);
  });

  it("does not pin governance_status to a single site when no hint is given", () => {
    expect(assertPrincipalEntitlement({
      toolName: "drupal_governance_status",
      args: {},
      identity: identity(),
      sites,
      grants: { "content-agent": ["production", "staging"] },
      defaultSite: "production",
    })).toBeNull();
  });

  it("still denies governance_status against an ungranted hinted site", () => {
    expect(() => assertPrincipalEntitlement({
      toolName: "drupal_governance_status",
      args: { site: "development" },
      identity: identity(),
      sites,
      grants: { "content-agent": ["production"] },
      defaultSite: "production",
    })).toThrow(/Not entitled to the requested target/);
  });

  it("returns the authoritative granted target on a clean call", () => {
    const resolved = resolveAuthoritativeTarget(
      { site: "production" },
      identity(),
      sites,
      { grants, defaultSite: "production" },
    );
    expect(resolved).toMatchObject({
      name: "production",
      source: "hint",
      site: expect.objectContaining({ baseUrl: "https://drupal.example.com" }),
    });
  });
});

describe("resources and prompts", () => {
  const resources = [
    { uri: "drupal://sites" },
    { uri: "drupal://{site}/content-types" },
    { uri: "drupal://{site}/security-policy" },
  ];
  const prompts = [
    { name: "drupal-content-audit" },
    { name: "drupal-create-article" },
    { name: "drupal-get-node" },
    { name: "drupal-create-node" },
  ];

  it("keeps the sites resource and hides site-bound resources without mcp_read", () => {
    const visible = filterResourcesByPrincipal(
      resources,
      identity({ scopes: [] }),
      sites,
      null,
    );
    expect(visible.map((r) => r.uri)).toEqual(["drupal://sites"]);
  });

  it("hides write prompts and write-tool prompts from a read-only principal", () => {
    const tools = [{ name: "drupal_get_node" }];
    const visible = filterPromptsByPrincipal(
      prompts,
      identity({ scopes: ["mcp_read"] }),
      tools,
    ).map((p) => p.name);
    expect(visible).toEqual(["drupal-content-audit", "drupal-get-node"]);
  });
});

describe("visibleSiteTargets", () => {
  it("never includes credentials in the public target list", () => {
    const secretSite = {
      ...prod,
      apiToken: "tok-secret-value",
      oauth: { clientSecret: "oauth-secret-value", scopes: ["mcp_read"] },
      password: "pw-secret-value",
    };
    const payload = visibleSiteTargets(
      identity({ scopes: ["mcp_read"] }),
      [secretSite],
      ["production", "staging"],
      { "content-agent": ["production"] },
    );
    expect(payload).toEqual({
      sites: ["production"],
      targets: [{
        name: "production",
        baseUrl: "https://drupal.example.com",
        source: "grant",
      }],
    });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });
});

describe("runWithIdentity", () => {
  it("stores the principal for the request and clears it afterwards", async () => {
    expect(getRequestIdentity()).toBeNull();
    const seen = await runWithIdentity(identity(), () => getRequestIdentity());
    expect(seen.sub).toBe("agent-1");
    expect(getRequestIdentity()).toBeNull();
  });
});
