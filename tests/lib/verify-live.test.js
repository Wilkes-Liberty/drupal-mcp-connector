import { describe, it, expect } from "vitest";
import { verifyLive, LIVE_CHECKS } from "../../src/lib/verify.js";

/**
 * The live half of the verifier proves the same claims against a running
 * target. Its negative probes invert the usual polarity: the probe PASSES when
 * the target refuses. A probe that succeeds is a finding, not a success — that
 * is the whole point of exercising mass read, configuration change and
 * live-content edit against a governed stack (#180).
 */

const site = (over = {}) => ({
  _name: "production",
  baseUrl: "https://drupal.example.com",
  requireSecureAuth: true,
  requireGovernance: true,
  oauth: {
    tokenUrl: "/oauth/token",
    clientId: "content-agent-production",
    clientSecret: "secret-value",
    scopes: ["mcp_read", "mcp_write"],
    grant: "client_credentials",
  },
  security: { preset: "content-editor" },
  ...over,
});

/** A response in the node-fetch shape. */
const reply = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/**
 * A transport scripted by URL fragment. Every route a healthy governed stack
 * would answer; individual tests override one route to break it.
 */
function scriptedTransport(overrides = {}) {
  const routes = {
    token: () => reply(200, { access_token: "t-123", expires_in: 300, token_type: "Bearer" }),
    readiness: () => reply(200, { contract_ready: true, reason: null, scope: "source_governance_contract" }),
    readinessAnonymous: () => reply(401, { error: "unauthorized" }),
    context: () => reply(200, { site: { name: "Example" }, content_types: { article: {} } }),
    massRead: () => reply(429, { errors: [{ code: "read_budget_exceeded" }] }),
    configWrite: () => reply(403, { errors: [{ code: "access_denied" }] }),
    contentEdit: () => reply(403, { errors: [{ code: "denied_publish" }] }),
    ...overrides,
  };
  const calls = [];
  const transport = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", authorized: Boolean(init.headers?.Authorization) });
    if (url.includes("/oauth/token")) return routes.token();
    if (url.includes("/drupal-mcp/readiness")) {
      return init.headers?.Authorization ? routes.readiness() : routes.readinessAnonymous();
    }
    if (url.includes("/drupal-mcp/context")) return routes.context();
    if (url.includes("page%5Blimit%5D") || url.includes("page[limit]")) return routes.massRead();
    if (url.includes("/jsonapi/") && init.method && init.method !== "GET") {
      return url.includes("system") ? routes.configWrite() : routes.contentEdit();
    }
    if (url.includes("/mcp")) return routes.configWrite();
    return reply(200, {});
  };
  transport.calls = calls;
  return transport;
}

const run = (over = {}, transportOverrides = {}) =>
  verifyLive(site(over), {
    transport: scriptedTransport(transportOverrides),
    now: () => new Date("2026-08-15T12:00:00Z"),
  });

const statusOf = (result, id) => result.checks.find((c) => c.id === id)?.status;
const findingsOf = (result, id) => result.checks.find((c) => c.id === id)?.findings ?? [];

describe("verifyLive — a healthy governed target", () => {
  it("passes every live check", async () => {
    const result = await run();
    const notPassing = result.checks.filter((c) => c.status !== "pass").map((c) => `${c.id}: ${c.findings.join(" ")}`);
    expect(notPassing).toEqual([]);
    expect(result.summary.ok).toBe(true);
    expect(LIVE_CHECKS.every((id) => result.checks.some((c) => c.id === id))).toBe(true);
  });

  it("produces evidence naming the target and the connector version", async () => {
    const result = await run();
    expect(result.mode).toBe("live");
    expect(result.subject).toMatchObject({ site: "production", host: "drupal.example.com" });
    expect(result.connectorVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.generatedAt).toBe("2026-08-15T12:00:00.000Z");
    expect(result.residuals.some((r) => r.id === "prompt_injection")).toBe(true);
  });

  it("never puts a token or a secret in the evidence", async () => {
    const serialized = JSON.stringify(await run());
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("t-123");
  });
});

describe("verifyLive — transport", () => {
  it("fails when the target is unreachable", async () => {
    const transport = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await verifyLive(site(), { transport, now: () => new Date() });
    expect(statusOf(result, "transport")).toBe("fail");
    expect(findingsOf(result, "transport").join(" ")).toMatch(/ECONNREFUSED|unreachable/i);
  });

  it("fails a plain-HTTP target before any request is made", async () => {
    const result = await run({ baseUrl: "http://drupal.example.com" });
    expect(statusOf(result, "transport")).toBe("fail");
  });
});

describe("verifyLive — principal authentication", () => {
  it("fails when the principal cannot mint a token", async () => {
    const result = await run({}, { token: () => reply(401, { error: "invalid_client" }) });
    expect(statusOf(result, "principal_auth")).toBe("fail");
    expect(findingsOf(result, "principal_auth").join(" ")).toMatch(/401|invalid_client/);
  });

  it("fails when an UNAUTHENTICATED request is served instead of refused", async () => {
    // The dangerous direction: the source answers a governed path to anyone.
    const result = await run({}, { readinessAnonymous: () => reply(200, { contract_ready: true }) });
    expect(statusOf(result, "principal_auth")).toBe("fail");
    expect(findingsOf(result, "principal_auth").join(" ")).toMatch(/anonymous/i);
  });

  it("skips rather than passes when the site configures no OAuth principal", async () => {
    const result = await run({ oauth: undefined, apiTokenEnv: "MCP_TOKEN" });
    expect(statusOf(result, "principal_auth")).toBe("skipped");
    expect(result.summary.ok).toBe(false);
  });
});

describe("verifyLive — source governance", () => {
  it("fails when the contract is not ready, and reports the source's own reason", async () => {
    const result = await run({}, { readiness: () => reply(503, { contract_ready: false, reason: "designated_consumer_missing" }) });
    expect(statusOf(result, "source_governance")).toBe("fail");
    expect(findingsOf(result, "source_governance").join(" ")).toContain("designated_consumer_missing");
  });

  it("fails when the readiness endpoint is absent altogether", async () => {
    const result = await run({}, { readiness: () => reply(404, {}) });
    expect(statusOf(result, "source_governance")).toBe("fail");
  });

  it("skips for a site that does not claim governance", async () => {
    const result = await run({ requireGovernance: false });
    expect(statusOf(result, "source_governance")).toBe("skipped");
  });
});

describe("verifyLive — entitlement filtering and target resolution", () => {
  it("fails when a config write is SERVED to a content-tier principal", async () => {
    const result = await run({}, { configWrite: () => reply(200, { ok: true }) });
    expect(statusOf(result, "entitlement_filtering")).toBe("fail");
    expect(findingsOf(result, "entitlement_filtering").join(" ")).toMatch(/served|accepted/i);
  });

  it("passes when the target refuses the out-of-tier operation", async () => {
    expect(statusOf(await run(), "entitlement_filtering")).toBe("pass");
  });

  it("fails when the target does not describe itself", async () => {
    const result = await run({}, { context: () => reply(500, {}) });
    expect(statusOf(result, "target_resolution")).toBe("fail");
  });
});

describe("verifyLive — negative probes", () => {
  it("passes a mass read only when it is refused, and fails when it is served", async () => {
    expect(statusOf(await run(), "probe_mass_read")).toBe("pass");

    const served = await run({}, { massRead: () => reply(200, { data: new Array(5000).fill({ type: "node--article" }) }) });
    expect(statusOf(served, "probe_mass_read")).toBe("fail");
    expect(findingsOf(served, "probe_mass_read").join(" ")).toMatch(/unbounded|served|refus/i);
  });

  it("passes a configuration change only when it is refused", async () => {
    expect(statusOf(await run(), "probe_config_change")).toBe("pass");
    const served = await run({}, { configWrite: () => reply(200, { ok: true }) });
    expect(statusOf(served, "probe_config_change")).toBe("fail");
  });

  it("passes a live-content edit only when it is refused", async () => {
    expect(statusOf(await run(), "probe_content_edit")).toBe("pass");
    const served = await run({}, { contentEdit: () => reply(200, { data: { id: "1" } }) });
    expect(statusOf(served, "probe_content_edit")).toBe("fail");
  });

  it("records the refusal code the target returned, as evidence", async () => {
    const result = await run();
    expect(findingsOf(result, "probe_mass_read")).toEqual([]);
    const probe = result.checks.find((c) => c.id === "probe_mass_read");
    expect(probe.observed).toMatchObject({ status: 429 });
    expect(JSON.stringify(probe.observed)).toContain("read_budget_exceeded");
  });

  it("skips the write probes for a read-only principal instead of claiming a pass", async () => {
    const result = await run({ oauth: { ...site().oauth, scopes: ["mcp_read"] } });
    expect(statusOf(result, "probe_config_change")).toBe("skipped");
    expect(statusOf(result, "probe_content_edit")).toBe("skipped");
    // The read probe still runs.
    expect(statusOf(result, "probe_mass_read")).toBe("pass");
  });
});
