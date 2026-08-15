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
  serverTools: { url: "/mcp" },
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
      return routes.contentEdit();
    }
    return reply(200, {});
  };
  transport.calls = calls;
  return transport;
}

/** The governed default: a config write through the bridge is refused. */
const refusingCallTool = async () => {
  throw new Error("Server-tool tool_api.mcp_sentinel_config_set error (-32000): access denied by MCP Sentinel policy");
};

const run = (over = {}, transportOverrides = {}, callTool = refusingCallTool) =>
  verifyLive(site(over), {
    transport: scriptedTransport(transportOverrides),
    callTool,
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

  it("fails when the token response carries no usable access token", async () => {
    const result = await run({}, { token: () => reply(200, { token_type: "Bearer", expires_in: 300 }) });
    expect(statusOf(result, "principal_auth")).toBe("fail");
    expect(findingsOf(result, "principal_auth").join(" ")).toMatch(/access token|usable/i);
  });

  it("skips the authenticated checks when there is no usable token, rather than passing them on 401s", async () => {
    const result = await run({}, {
      token: () => reply(200, {}),
      readiness: () => reply(401, {}),
    });
    // Without a token, a refusal proves nothing about policy.
    expect(statusOf(result, "source_governance")).toBe("skipped");
    expect(statusOf(result, "probe_mass_read")).toBe("skipped");
    expect(result.summary.ok).toBe(false);
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
    const served = async () => ({ ok: true });
    const result = await run({}, {}, served);
    expect(statusOf(result, "entitlement_filtering")).toBe("fail");
    expect(findingsOf(result, "entitlement_filtering").join(" ")).toMatch(/served|accepted/i);
  });

  it("passes when the target refuses the out-of-tier operation", async () => {
    expect(statusOf(await run(), "entitlement_filtering")).toBe("pass");
  });

  it("exercises the real bridge contract: the governed tool name and its argument shape", async () => {
    const calls = [];
    const spy = async (siteArg, toolName, args) => {
      calls.push({ site: siteArg?._name, toolName, args });
      throw new Error("refused");
    };
    await run({}, {}, spy);
    expect(calls.length).toBeGreaterThan(0);
    // The bridge exposes the governed config tools under their tool_api name;
    // a hand-rolled JSON-RPC body with a different name proves nothing.
    expect(calls[0].toolName).toBe("tool_api.mcp_sentinel_config_set");
    expect(calls[0].args).toHaveProperty("name");
    expect(calls[0].args).toHaveProperty("data");
  });

  it("skips entitlement filtering — never passes it — when no bridge is configured", async () => {
    const result = await run({ serverTools: undefined }, {}, refusingCallTool);
    expect(statusOf(result, "entitlement_filtering")).toBe("skipped");
    expect(findingsOf(result, "entitlement_filtering").join(" ")).toMatch(/bridge|serverTools/i);
    expect(statusOf(result, "probe_config_change")).toBe("skipped");
    expect(result.summary.ok).toBe(false);
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

  it("passes a mass read that is BOUNDED rather than refused", async () => {
    // A source that answers 200 with a capped page has bounded the read — that
    // is the control working, not a finding.
    const bounded = await run({}, { massRead: () => reply(200, { data: new Array(50).fill({ type: "node--article" }) }) });
    expect(statusOf(bounded, "probe_mass_read")).toBe("pass");
    const probe = bounded.checks.find((c) => c.id === "probe_mass_read");
    expect(probe.observed).toMatchObject({ items: 50 });
  });

  it("skips — never passes — a successful mass read it cannot measure", async () => {
    const unmeasurable = await run({}, { massRead: () => reply(200, { meta: { count: "lots" } }) });
    expect(statusOf(unmeasurable, "probe_mass_read")).toBe("skipped");
    expect(unmeasurable.summary.ok).toBe(false);
  });

  it("passes a configuration change only when it is refused", async () => {
    expect(statusOf(await run(), "probe_config_change")).toBe("pass");
    const served = async () => ({ ok: true });
    expect(statusOf(await run({}, {}, served), "probe_config_change")).toBe("fail");
  });

  it("skips the config probe for a principal that legitimately holds mcp_config", async () => {
    // A developer or break-glass role is SUPPOSED to be able to write config;
    // failing its healthy run would train operators to ignore the verifier.
    const developer = { ...site().oauth, scopes: ["mcp_read", "mcp_write", "mcp_config"] };
    const served = async () => ({ ok: true });
    const result = await run({ oauth: developer }, {}, served);
    expect(statusOf(result, "probe_config_change")).toBe("skipped");
    expect(findingsOf(result, "probe_config_change").join(" ")).toMatch(/mcp_config/);
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

  it("runs the config probe for a read-only principal but skips the content-edit one", async () => {
    // Polarity by what the probe can actually prove. A read-only principal
    // being refused a CONFIG write is a real proof of the source-side scope
    // gate, so that probe runs. A content edit refused for want of mcp_write
    // proves only that the scope is missing — not that the publish gate holds
    // for a principal that can otherwise write — so that one is skipped.
    const result = await run({ oauth: { ...site().oauth, scopes: ["mcp_read"] } });
    expect(statusOf(result, "probe_config_change")).toBe("pass");
    expect(statusOf(result, "probe_content_edit")).toBe("skipped");
    expect(findingsOf(result, "probe_content_edit").join(" ")).toMatch(/write scope/i);
    // The read probe still runs.
    expect(statusOf(result, "probe_mass_read")).toBe("pass");
  });
});

describe("verifyLive — a bridge error is not automatically a refusal", () => {
  /**
   * The probe passes when the SOURCE decided to refuse. A thrown error can
   * equally mean the probe never ran — no bridge configured, a session that
   * would not initialise, a network failure, a malformed call. Those are
   * `skipped`, because scoring them as refusals produces a green evidence
   * document for an install that never proved a config deny.
   */
  const throwing = (message) => async () => {
    throw new Error(message);
  };
  const withSite = (over = {}) => site(over);
  const runWith = (callTool, over = {}) =>
    verifyLive(withSite(over), {
      transport: scriptedTransport(),
      callTool,
      now: () => new Date("2026-08-15T12:00:00Z"),
    });

  it("counts a tool-level refusal as a pass", async () => {
    const result = await runWith(throwing("Server-tool tool_api.mcp_sentinel_config_set reported an error: denied by MCP Sentinel policy"));
    expect(statusOf(result, "probe_config_change")).toBe("pass");
    expect(statusOf(result, "entitlement_filtering")).toBe("pass");
  });

  it("counts a server-defined JSON-RPC error as a pass, but a malformed-call error as a skip", async () => {
    const denied = await runWith(throwing("Server-tool tool_api.mcp_sentinel_config_set error (-32000): access denied"));
    expect(statusOf(denied, "probe_config_change")).toBe("pass");

    const malformed = await runWith(throwing("Server-tool tool_api.mcp_sentinel_config_set error (-32601): Method not found"));
    expect(statusOf(malformed, "probe_config_change")).toBe("skipped");
    expect(findingsOf(malformed, "probe_config_change").join(" ")).toMatch(/never reached a policy decision|proves nothing/i);

    const badParams = await runWith(throwing("Server-tool tool_api.mcp_sentinel_config_set error (-32602): Invalid params"));
    expect(statusOf(badParams, "probe_config_change")).toBe("skipped");
  });

  it("counts an authorisation status as a pass, and a server failure as a skip", async () => {
    const forbidden = await runWith(throwing("Server-tool call tool_api.mcp_sentinel_config_set failed 403: forbidden"));
    expect(statusOf(forbidden, "probe_config_change")).toBe("pass");

    const serverError = await runWith(throwing("Server-tool call tool_api.mcp_sentinel_config_set failed 500: Internal Server Error"));
    expect(statusOf(serverError, "probe_config_change")).toBe("skipped");

    const notFound = await runWith(throwing("Server-tool call tool_api.mcp_sentinel_config_set failed 404: Not Found"));
    expect(statusOf(notFound, "probe_config_change")).toBe("skipped");
  });

  it("skips a session that would not initialise, and a network failure", async () => {
    const session = await runWith(throwing("Server-tool session initialize failed 500: boom"));
    expect(statusOf(session, "probe_config_change")).toBe("skipped");

    const network = await runWith(throwing("request to https://drupal.example.com/mcp failed, reason: connect ECONNREFUSED"));
    expect(statusOf(network, "probe_config_change")).toBe("skipped");
    expect(network.summary.ok).toBe(false);
  });

  it("records what was observed either way, so the evidence shows which it was", async () => {
    const refused = await runWith(throwing("Server-tool tool_api.mcp_sentinel_config_set reported an error: denied"));
    const probe = refused.checks.find((c) => c.id === "probe_config_change");
    expect(probe.observed).toMatchObject({ served: false, outcome: "refused" });

    const skipped = await runWith(throwing("Server-tool session initialize failed 503: unavailable"));
    const skippedProbe = skipped.checks.find((c) => c.id === "probe_config_change");
    expect(skippedProbe.observed).toMatchObject({ outcome: "unexercised" });
  });
});
