import { describe, it, expect } from "vitest";
import { verifyStatic, STATIC_CHECKS, RESIDUALS, NOT_APPLICABLE } from "../../src/lib/verify.js";

/**
 * A config whose every site passes: reserved hostnames, OAuth with named
 * scopes and a per-role secret env, governance declared, presets set.
 */
const secureConfig = (over = {}) => ({
  defaultSite: "prod",
  sites: {
    prod: {
      baseUrl: "https://drupal.example.com",
      requireSecureAuth: true,
      requireGovernance: true,
      api: "jsonapi",
      oauth: {
        clientId: "content-agent-prod",
        clientSecretEnv: "MCP_CONTENT_PROD_SECRET",
        scopes: ["mcp_read", "mcp_write"],
        grant: "client_credentials",
      },
      security: { preset: "write-plane" },
    },
    dev: {
      baseUrl: "https://drupal.example.test",
      requireSecureAuth: true,
      requireGovernance: true,
      api: "jsonapi",
      oauth: {
        clientId: "developer-agent-dev",
        clientSecretEnv: "MCP_DEVELOPER_DEV_SECRET",
        scopes: ["mcp_read", "mcp_write", "mcp_config"],
        grant: "client_credentials",
      },
      security: { preset: "config-editor" },
    },
  },
  ...over,
});

/** Runs the verifier with a fixed clock so evidence is comparable. */
const run = (config, options = {}) =>
  verifyStatic(config, {
    source: "test-fixture",
    now: () => new Date("2026-08-15T12:00:00Z"),
    ...options,
    env: { MCP_TRANSPORT: "stdio", ...(options.env || {}) },
  });

/** The status of one check id. */
const statusOf = (result, id) => result.checks.find((c) => c.id === id)?.status;

/** The detail lines of one check id. */
const detailOf = (result, id) => result.checks.find((c) => c.id === id)?.findings ?? [];

describe("verifyStatic — a secure, tenant-neutral configuration", () => {
  it("passes every check and reports ok", () => {
    const result = run(secureConfig());
    expect(result.summary.ok).toBe(true);
    expect(result.summary.fail).toBe(0);
    for (const id of STATIC_CHECKS) {
      expect(statusOf(result, id), `check ${id}`).toBe("pass");
    }
  });

  it("produces evidence that pins what was verified", () => {
    const result = run(secureConfig());
    expect(result.tool).toBe("drupal-mcp-connector verify");
    expect(result.connectorVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.generatedAt).toBe("2026-08-15T12:00:00.000Z");
    expect(result.subject).toMatchObject({ source: "test-fixture", siteCount: 2 });
    expect(result.subject.sites).toEqual(["prod", "dev"]);
    // A digest of the verified configuration, so a later claim can be tied to
    // the exact input — and stable across runs of the same input.
    expect(result.subject.configDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run(secureConfig()).subject.configDigest).toBe(result.subject.configDigest);
    expect(run(secureConfig({ defaultSite: "dev" })).subject.configDigest).not.toBe(result.subject.configDigest);
  });

  it("names prompt injection as a managed residual rather than a solved property", () => {
    const result = run(secureConfig());
    expect(RESIDUALS.map((r) => r.id)).toContain("prompt_injection");
    const residual = result.residuals.find((r) => r.id === "prompt_injection");
    expect(residual.status).toBe("managed");
    expect(residual.detail.toLowerCase()).toContain("not");
  });

  it("names loopback shared_bearer as a managed residual with a dated kill", () => {
    const result = run(secureConfig());
    expect(RESIDUALS.map((r) => r.id)).toContain("loopback_shared_bearer");
    const residual = result.residuals.find((r) => r.id === "loopback_shared_bearer");
    expect(residual.status).toBe("managed");
    expect(residual.detail).toEqual(expect.stringContaining("shared_bearer"));
    expect(residual.detail).toEqual(expect.stringContaining("v3.0.0"));
    expect(residual.detail).toEqual(expect.stringContaining("#231"));
  });

  it("never lets a secret value reach the evidence", () => {
    const config = secureConfig();
    config.sites.prod.oauth.clientSecret = "SUPER-SECRET-VALUE";
    const serialized = JSON.stringify(run(config));
    expect(serialized).not.toContain("SUPER-SECRET-VALUE");
  });
});

describe("verifyStatic — inbound_auth", () => {
  it("passes a stdio-shaped install that has no inbound resource server", () => {
    expect(statusOf(run(secureConfig()), "inbound_auth")).toBe("pass");
  });

  it("fails network-facing HTTPS that still relies on MCP_AUTH_TOKEN", () => {
    const result = run(secureConfig(), {
      env: { MCP_TRANSPORT: "https", MCP_BIND_HOST: "0.0.0.0", MCP_AUTH_TOKEN: "shared-secret" },
    });
    expect(statusOf(result, "inbound_auth")).toBe("fail");
    expect(detailOf(result, "inbound_auth").join(" ")).toContain("resource server");
  });

  it("passes network-facing HTTPS when issuer and audience are set", () => {
    const result = run(secureConfig({
      auth: {
        issuer: "https://idp.example.com",
        audience: "https://mcp.example.com/mcp",
        resource: "https://mcp.example.com/mcp",
      },
    }), {
      env: { MCP_TRANSPORT: "https", MCP_BIND_HOST: "0.0.0.0" },
    });
    expect(statusOf(result, "inbound_auth")).toBe("pass");
  });

  it("fails an inbound issuer that is not HTTPS", () => {
    const result = run(secureConfig({
      auth: { issuer: "http://idp.example.com", audience: "https://mcp.example.com/mcp" },
    }));
    expect(statusOf(result, "inbound_auth")).toBe("fail");
  });
});

describe("verifyStatic — transport", () => {
  it("fails a site served over plain HTTP", () => {
    const config = secureConfig();
    config.sites.prod.baseUrl = "http://drupal.example.com";
    const result = run(config);
    expect(statusOf(result, "transport")).toBe("fail");
    expect(detailOf(result, "transport").join(" ")).toContain("prod");
    expect(result.summary.ok).toBe(false);
  });

  it("fails a site that claims secure auth without HTTPS", () => {
    const config = secureConfig();
    config.sites.prod.baseUrl = "http://drupal.example.com";
    expect(statusOf(run(config), "transport")).toBe("fail");
  });

  it("passes localhost over HTTP — a loopback dev target is not an exposed transport", () => {
    const config = secureConfig();
    config.sites.dev.baseUrl = "http://localhost:8080";
    expect(statusOf(run(config), "transport")).toBe("pass");
  });
});

describe("verifyStatic — principal authentication", () => {
  it("fails an inline client secret", () => {
    const config = secureConfig();
    delete config.sites.prod.oauth.clientSecretEnv;
    config.sites.prod.oauth.clientSecret = "inline";
    expect(statusOf(run(config), "principal_auth")).toBe("fail");
  });

  it("fails an inline API token, and passes the env-var form", () => {
    const config = secureConfig();
    delete config.sites.prod.oauth;
    config.sites.prod.apiToken = "inline-token";
    expect(statusOf(run(config), "principal_auth")).toBe("fail");

    const viaEnv = secureConfig();
    delete viaEnv.sites.prod.oauth;
    viaEnv.sites.prod.apiTokenEnv = "MCP_PROD_TOKEN";
    expect(statusOf(run(viaEnv), "principal_auth")).toBe("pass");
  });

  it("fails a site with no credential at all", () => {
    const config = secureConfig();
    delete config.sites.prod.oauth;
    expect(statusOf(run(config), "principal_auth")).toBe("fail");
  });

  it("fails when requireSecureAuth is off on a governed site", () => {
    const config = secureConfig();
    config.sites.prod.requireSecureAuth = false;
    expect(statusOf(run(config), "principal_auth")).toBe("fail");
  });
});

describe("verifyStatic — scope grant (the empty-scope bypass)", () => {
  it("fails an OAuth site that names no scopes", () => {
    const config = secureConfig();
    config.sites.prod.oauth.scopes = [];
    const result = run(config);
    expect(statusOf(result, "scope_grant")).toBe("fail");
    expect(detailOf(result, "scope_grant").join(" ")).toMatch(/scope/i);
  });

  it("fails when the scopes key is absent", () => {
    const config = secureConfig();
    delete config.sites.prod.oauth.scopes;
    expect(statusOf(run(config), "scope_grant")).toBe("fail");
  });

  it("passes when every OAuth site names its scopes", () => {
    expect(statusOf(run(secureConfig()), "scope_grant")).toBe("pass");
  });
});

describe("verifyStatic — source governance", () => {
  it("fails an OAuth-governed site that does not require governance", () => {
    const config = secureConfig();
    config.sites.prod.requireGovernance = false;
    const result = run(config);
    expect(statusOf(result, "source_governance")).toBe("fail");
    expect(detailOf(result, "source_governance").join(" ")).toContain("prod");
  });

  it("exempts an explicitly local development-preset site", () => {
    const config = secureConfig();
    config.sites.dev.baseUrl = "http://localhost:8080";
    config.sites.dev.requireGovernance = false;
    config.sites.dev.security = { preset: "development" };
    expect(statusOf(run(config), "source_governance")).toBe("pass");
  });

  it("does not exempt a development preset on a non-local host", () => {
    const config = secureConfig();
    config.sites.dev.requireGovernance = false;
    config.sites.dev.security = { preset: "development" };
    expect(statusOf(run(config), "source_governance")).toBe("fail");
  });
});

describe("verifyStatic — role separation", () => {
  it("fails two roles sharing one secret env var", () => {
    const config = secureConfig();
    config.sites.dev.oauth.clientSecretEnv = "MCP_CONTENT_PROD_SECRET";
    const result = run(config);
    expect(statusOf(result, "role_separation")).toBe("fail");
    expect(detailOf(result, "role_separation").join(" ")).toContain("MCP_CONTENT_PROD_SECRET");
  });

  it("fails two roles sharing one client id", () => {
    const config = secureConfig();
    config.sites.dev.oauth.clientId = "content-agent-prod";
    expect(statusOf(run(config), "role_separation")).toBe("fail");
  });

  it("passes when each role carries its own client id and secret", () => {
    expect(statusOf(run(secureConfig()), "role_separation")).toBe("pass");
  });
});

describe("verifyStatic — entitlement", () => {
  it("fails a site with no security preset", () => {
    const config = secureConfig();
    delete config.sites.prod.security;
    expect(statusOf(run(config), "entitlement")).toBe("fail");
  });

  it("fails the development preset on a non-local host", () => {
    const config = secureConfig();
    config.sites.prod.security = { preset: "development" };
    const result = run(config);
    expect(statusOf(result, "entitlement")).toBe("fail");
    expect(detailOf(result, "entitlement").join(" ")).toContain("development");
  });

  it("allows the development preset on a loopback host", () => {
    const config = secureConfig();
    config.sites.dev.baseUrl = "http://localhost:8080";
    config.sites.dev.security = { preset: "development" };
    config.sites.dev.requireGovernance = false;
    expect(statusOf(run(config), "entitlement")).toBe("pass");
  });
});

describe("verifyStatic — target resolution", () => {
  it("fails when defaultSite names a site that does not exist", () => {
    const config = secureConfig({ defaultSite: "nowhere" });
    const result = run(config);
    expect(statusOf(result, "target_resolution")).toBe("fail");
    expect(detailOf(result, "target_resolution").join(" ")).toContain("nowhere");
  });

  it("fails a site with no baseUrl", () => {
    const config = secureConfig();
    delete config.sites.dev.baseUrl;
    expect(statusOf(run(config), "target_resolution")).toBe("fail");
  });

  it("fails when there are no sites at all", () => {
    const result = run({ defaultSite: "prod", sites: {} });
    expect(statusOf(result, "target_resolution")).toBe("fail");
  });
});

describe("verifyStatic — tenant neutrality", () => {
  it("fails a hostname outside the reserved example ranges", () => {
    const config = secureConfig();
    config.sites.prod.baseUrl = "https://api.int.acmecorp.com";
    const result = run(config);
    expect(statusOf(result, "tenant_neutrality")).toBe("fail");
    expect(detailOf(result, "tenant_neutrality").join(" ")).toContain("api.int.acmecorp.com");
  });

  it("fails a tenant identifier hiding in a non-URL value", () => {
    const config = secureConfig();
    config.sites.prod.audit = { linkCheckAllowedHosts: ["acmecorp.com"] };
    expect(statusOf(run(config), "tenant_neutrality")).toBe("fail");
  });

  it("accepts the reserved example domains, .test, .invalid and loopback", () => {
    const config = secureConfig();
    config.sites.prod.baseUrl = "https://drupal.example.org";
    config.sites.dev.baseUrl = "https://drupal.example.test";
    config.sites.extra = {
      baseUrl: "http://127.0.0.1:8080",
      requireSecureAuth: true,
      security: { preset: "development" },
      apiTokenEnv: "MCP_EXTRA_TOKEN",
    };
    const result = run(config);
    expect(statusOf(result, "tenant_neutrality")).toBe("pass");
  });

  it("allows www.drupal.org — a public project host is not a tenant identifier", () => {
    const config = secureConfig();
    config.sites.prod.audit = { linkCheckAllowedHosts: ["www.drupal.org"] };
    expect(statusOf(run(config), "tenant_neutrality")).toBe("pass");
  });
});

describe("verifyStatic — reporting", () => {
  it("reports every failing check, not just the first", () => {
    const config = secureConfig();
    config.sites.prod.baseUrl = "http://acme.internal";
    config.sites.prod.oauth.scopes = [];
    delete config.sites.prod.security;
    const result = run(config);
    const failed = result.checks.filter((c) => c.status === "fail").map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["transport", "scope_grant", "entitlement", "tenant_neutrality"]));
    expect(result.summary.fail).toBe(failed.length);
  });

  it("skips — never silently passes — when there is nothing to check", () => {
    const result = run({ sites: {} });
    const skipped = result.checks.filter((c) => c.status === "skipped").map((c) => c.id);
    expect(skipped).toContain("principal_auth");
    expect(result.summary.ok).toBe(false);
  });
});

describe("verifyStatic — inapplicable is not unexercised", () => {
  /**
   * A check that does not apply must not fail the run. A token-only install
   * has no scope vocabulary and no second role, so scoring those as unproven
   * would mean a perfectly secure install could never verify — and an
   * operator who cannot ever pass stops running the tool.
   */
  const tokenOnly = {
    defaultSite: "prod",
    sites: {
      prod: {
        baseUrl: "https://drupal.example.com",
        requireSecureAuth: true,
        apiTokenEnv: "MCP_PROD_TOKEN",
        security: { preset: "production-strict" },
      },
    },
  };

  it("marks the OAuth-only checks not-applicable, and the run still passes", () => {
    const result = run(tokenOnly);
    expect(statusOf(result, "scope_grant")).toBe(NOT_APPLICABLE);
    expect(statusOf(result, "role_separation")).toBe(NOT_APPLICABLE);
    expect(result.summary.fail).toBe(0);
    expect(result.summary.skipped).toBe(0);
    expect(result.summary.notApplicable).toBe(2);
    expect(result.summary.ok).toBe(true);
  });

  it("still fails a token-only install that is insecure", () => {
    const insecure = JSON.parse(JSON.stringify(tokenOnly));
    insecure.sites.prod.baseUrl = "http://drupal.example.com";
    delete insecure.sites.prod.security;
    const result = run(insecure);
    expect(result.summary.ok).toBe(false);
    expect(statusOf(result, "transport")).toBe("fail");
    expect(statusOf(result, "entitlement")).toBe("fail");
  });

  it("keeps an empty configuration failing — nothing to check is not a pass", () => {
    const result = run({ sites: {} });
    expect(result.summary.ok).toBe(false);
    expect(result.checks.some((c) => c.status === "skipped")).toBe(true);
  });
});
