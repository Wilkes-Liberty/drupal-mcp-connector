import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOSTED_PUBLIC_CLIENT_ORIGINS } from "../../src/lib/http-transport.js";
import {
  AUTHORIZE_GATES_EXPECT,
  AUTHORIZE_GATES_UNAUTHENTICATED_REASON,
  CLAUDE_BROWSER_ORIGIN,
  CLAUDE_CODE_CIMD_URL,
  CLAUDE_HOSTED_CIMD_URL,
  CLAUDE_HOSTED_REDIRECT,
  CLIENT_INVENTORY,
  OPERATORS_DENY_FLOW,
  OPERATORS_STAFF_GATE,
  OPERATORS_STAFF_ROLE,
  CURSOR_CLIENT_ID,
  DEFAULT_HOSTS,
  DENY_ORIGINS,
  FOREIGN_LOOKALIKE_ORIGIN,
  FOREIGN_ORIGIN,
  GROK_CIMD_URL,
  GROK_CLIENT_ID,
  ISSUER,
  READ_TOOL,
  SECRET_ENV,
  advertisedWriteLikeTools,
  assertReadOnlyTool,
  classifyAsMetadata,
  classifyAuthorize,
  classifyAuthorizeGates,
  classifyDcrClosed,
  classifyGrokCimd,
  classifyHealth,
  classifyMcpJsonRpc,
  classifyOriginPreflight,
  classifyOriginRefused,
  classifyProtectedResource,
  classifyUnauthenticatedMcp,
  isExactIssuer,
  decodeJwtPayload,
  countSkippedSecurityGates,
  declaredClientIds,
  formatEt,
  formatMarkdown,
  formatOverallLine,
  isOperatorsDenyPage,
  isRequiredSignedInStep,
  isSecurityGateStep,
  main,
  parseArgs,
  parseAuthorizeResponse,
  parseKcContext,
  parseWwwAuthenticate,
  readTokenConfig,
  redactSecrets,
  resolveAllowOrigins,
  resolveClientInventory,
  resolveClientsProvisioned,
  retryAfterMs,
  runAcceptance,
} from "../../scripts/hosted-acceptance.js";

const noopSleep = async () => {};

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function jwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.x`;
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: {
      forEach(fn) {
        for (const [key, value] of Object.entries(headers)) fn(value, key);
      },
      get(key) {
        return headers[key.toLowerCase()] || headers[key] || null;
      },
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

describe("hosted acceptance classifiers", () => {
  it("formats timestamps in America/New_York", () => {
    expect(formatEt(new Date("2026-10-18T05:31:00Z"))).toMatch(/2026-10-18 01:31:00 EDT/);
  });

  it("redacts bearer tokens, JWTs, hyphenated opaque bearers, and client_secret assignments", () => {
    const jwtValue = jwt({ sub: "lab" });
    const opaque = "abcdefghijklmnopqrstuv-wxyz-0123456789abcd";
    const raw = `Authorization: Bearer ${jwtValue} Bearer ${opaque} client_secret=super-secret-value`;
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).not.toContain(jwtValue);
    expect(redacted).not.toContain(opaque);
    expect(redacted).not.toMatch(/Bearer\s+eyJ/);
    expect(redacted).toMatch(/\[redacted\]/);
  });

  it("requires a Bearer resource_metadata challenge on unauthenticated /mcp", () => {
    const metadata = "https://mcp.staging.wilkesliberty.com/.well-known/oauth-protected-resource/mcp";
    expect(classifyUnauthenticatedMcp({
      status: 401,
      wwwAuthenticate: `Bearer realm="mcp", error="invalid_token", resource_metadata="${metadata}"`,
    }, metadata).ok).toBe(true);
    expect(classifyUnauthenticatedMcp({ status: 200, wwwAuthenticate: "" }, metadata).ok).toBe(false);
    expect(classifyUnauthenticatedMcp({
      status: 401,
      wwwAuthenticate: "Bearer error=\"invalid_token\"",
    }, metadata).ok).toBe(false);
    expect(classifyUnauthenticatedMcp({
      status: 403,
      wwwAuthenticate: `Bearer resource_metadata="${metadata}"`,
    }, metadata).ok).toBe(false);
  });

  it("fails closed on a missing Origin refusal", () => {
    expect(classifyOriginRefused({ status: 403 }).ok).toBe(true);
    expect(classifyOriginRefused({ status: 401 }).ok).toBe(false);
    expect(classifyOriginRefused({ status: 200 }).ok).toBe(false);
    expect(classifyOriginRefused({ status: 204 }).ok).toBe(false);
  });

  it("requires 204 on allowlisted Origin preflight and fails any other status", () => {
    expect(classifyOriginPreflight({ status: 204 }).ok).toBe(true);
    expect(classifyOriginPreflight({ status: 403 }).ok).toBe(false);
    expect(classifyOriginPreflight({ status: 401 }).ok).toBe(false);
    expect(classifyOriginPreflight({ status: 200 }).ok).toBe(false);
  });

  it("classifies Keycloak authorize login vs invalid redirect vs unknown client", () => {
    const login = parseAuthorizeResponse({
      status: 200,
      body: "const kcContext = {\"pageId\": \"login-username\"}",
      headers: {},
    });
    expect(classifyAuthorize(login, "login").ok).toBe(true);
    expect(classifyAuthorize(login, "invalid_redirect").ok).toBe(false);

    const badRedirect = parseAuthorizeResponse({
      status: 400,
      body: "{\"pageId\":\"error\"}",
      headers: {
        "set-cookie": `KC_STATE_CHECKER=${jwt({ mky: "invalidParameterMessage", mpar: ["redirect_uri"] })}`,
      },
    });
    expect(classifyAuthorize(badRedirect, "invalid_redirect").ok).toBe(true);
    expect(classifyAuthorize(badRedirect, "login").ok).toBe(false);

    const unknown = parseAuthorizeResponse({
      status: 400,
      body: "{\"pageId\":\"error\"}",
      headers: {
        "set-cookie": `KC_STATE_CHECKER=${jwt({ mky: "clientNotFoundMessage", mpar: [] })}`,
      },
    });
    expect(classifyAuthorize(unknown, "client_not_found").ok).toBe(true);
    expect(classifyAuthorize(unknown, "login").ok).toBe(false);
    expect(classifyAuthorize(login, "client_not_found").ok).toBe(false);
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });

  it("skips consent and the operators staff gate when the login page does not expose them", () => {
    const login = parseAuthorizeResponse({
      status: 200,
      body: "const kcContext = {\"pageId\": \"login-username\"};",
      headers: {},
    });
    const skipped = classifyAuthorizeGates(login);
    expect(skipped.skipped).toBe(true);
    expect(skipped.ok).toBeNull();
    expect(skipped.reason).toBe(AUTHORIZE_GATES_UNAUTHENTICATED_REASON);
    expect(skipped.reason).toMatch(/wl-operator/);
    expect(skipped.reason).toMatch(/browser-deny-non-operators/);
  });

  it("fails when the authorize page exposes consent off or a missing operators staff gate", () => {
    const noConsent = parseAuthorizeResponse({
      status: 200,
      body: JSON.stringify({ pageId: "login-username", consentRequired: false, staffGate: true }),
    });
    expect(classifyAuthorizeGates(noConsent).ok).toBe(false);
    expect(classifyAuthorizeGates(noConsent).reason).toMatch(/consentRequired=false/);

    const noStaff = parseAuthorizeResponse({
      status: 200,
      body: JSON.stringify({ pageId: "login-username", consentRequired: true, staffGate: false }),
    });
    expect(classifyAuthorizeGates(noStaff).ok).toBe(false);
    expect(classifyAuthorizeGates(noStaff).reason).toBe(`${OPERATORS_STAFF_GATE} absent`);
  });

  it("passes when the authorize page requires consent and the operators staff gate", () => {
    const body = JSON.stringify({ pageId: "login-consent", consentRequired: true, staffGate: true });
    expect(parseKcContext(body).consentRequired).toBe(true);
    expect(classifyAuthorizeGates(parseAuthorizeResponse({ status: 200, body })).ok).toBe(true);
  });

  it("detects the browser-deny-non-operators deny page as the operators staff gate", () => {
    const denyHtml = `<html data-flow="${OPERATORS_DENY_FLOW}">access denied</html>`;
    expect(isOperatorsDenyPage(denyHtml, "error")).toBe(true);
    const denied = parseAuthorizeResponse({ status: 200, body: denyHtml });
    expect(denied.staffGate).toBe(true);
    expect(classifyAuthorizeGates(denied).ok).toBe(true);

    const login = parseAuthorizeResponse({
      status: 200,
      body: "const kcContext = {\"pageId\": \"login-username\"};",
    });
    expect(isOperatorsDenyPage(login.pageId, login.pageId)).toBe(false);
    expect(login.staffGate).toBeUndefined();
  });

  it("treats anonymous DCR 403 Trusted Hosts as closed and a 200 registration as a finding", () => {
    expect(classifyDcrClosed({
      status: 403,
      body: JSON.stringify({
        error: "insufficient_scope",
        error_description: "Policy 'Trusted Hosts' rejected request to client-registration service. Details: Host not trusted.",
      }),
    }).ok).toBe(true);
    expect(classifyDcrClosed({ status: 200, body: "{\"client_id\":\"new\"}" }).ok).toBe(false);
    expect(classifyDcrClosed({ status: 403, body: "Forbidden" }).ok).toBe(false);
  });

  it("pins hosted PRM to the shared issuer and mcp_read only", () => {
    const resource = "https://mcp.wilkesliberty.com/mcp";
    expect(classifyProtectedResource({
      status: 200,
      json: {
        resource,
        authorization_servers: [ISSUER],
        scopes_supported: ["mcp_read"],
      },
    }, resource).ok).toBe(true);
    expect(classifyProtectedResource({
      status: 200,
      json: {
        resource,
        authorization_servers: [ISSUER],
        scopes_supported: ["mcp_read", "mcp_write"],
      },
    }, resource).ok).toBe(false);
  });

  it("rejects lookalike authorization_servers URLs that contain the issuer string", () => {
    const resource = "https://mcp.wilkesliberty.com/mcp";
    const lookalikes = [
      `https://evil.example/?q=${ISSUER}`,
      `https://evil.example/${ISSUER}`,
      "https://auth.wilkesliberty.com.evil.example/realms/wilkesliberty",
      "https://auth.wilkesliberty.com/realms/wilkesliberty/extra",
      "https://auth.wilkesliberty.com/realms/wilkesliberty?next=1",
      "https://auth.wilkesliberty.com/realms/wilkesliberty#frag",
      "https://user:pass@auth.wilkesliberty.com/realms/wilkesliberty",
      "http://auth.wilkesliberty.com/realms/wilkesliberty",
      ISSUER.replace("https://", "https://user@"),
    ];
    for (const server of lookalikes) {
      expect(isExactIssuer(server), server).toBe(false);
      expect(classifyProtectedResource({
        status: 200,
        json: {
          resource,
          authorization_servers: [server],
          scopes_supported: ["mcp_read"],
        },
      }, resource).ok, server).toBe(false);
    }
    expect(isExactIssuer(ISSUER)).toBe(true);
    expect(isExactIssuer(`${ISSUER}/`)).toBe(false);
    expect(isExactIssuer("")).toBe(false);
    expect(isExactIssuer("not a url")).toBe(false);
    expect(classifyProtectedResource({
      status: 200,
      json: {
        resource,
        authorization_servers: ISSUER,
        scopes_supported: ["mcp_read"],
      },
    }, resource).ok).toBe(false);
  });

  it("requires S256 and mcp_read on AS metadata and records CIMD off", () => {
    const pass = classifyAsMetadata({
      status: 200,
      json: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp_read"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      },
    });
    expect(pass.ok).toBe(true);
    expect(pass.cimd).toBe(false);
    expect(pass.publicTokenAuth).toBe(false);
    expect(classifyAsMetadata({ status: 200, json: { issuer: "https://evil.example" } }).ok).toBe(false);
  });

  it("accepts the published Grok CIMD and rejects a renamed client_id", () => {
    expect(classifyGrokCimd({
      status: 200,
      json: {
        client_id: GROK_CIMD_URL,
        token_endpoint_auth_method: "none",
        redirect_uris: [
          "https://grok.com/connectors-oauth-exchange-code/",
          "https://console.x.ai/connectors-oauth-exchange-code/",
        ],
      },
    }).ok).toBe(true);
    expect(classifyGrokCimd({
      status: 200,
      json: { client_id: "grok-bot", token_endpoint_auth_method: "none", redirect_uris: [] },
    }).ok).toBe(false);
  });

  it("does not treat an MCP error envelope as a successful tool call", () => {
    expect(classifyHealth({ status: 200, json: { status: "ok" } }).ok).toBe(true);
    expect(classifyMcpJsonRpc({
      status: 200,
      json: { result: { protocolVersion: "2026-07-28" } },
    }, "initialize").ok).toBe(true);
    expect(classifyMcpJsonRpc({
      status: 200,
      json: { result: { tools: [{ name: READ_TOOL }] } },
    }, "tools/list").toolCount).toBe(1);
    expect(classifyMcpJsonRpc({
      status: 200,
      json: { result: { tools: [{ name: READ_TOOL }, { name: "drupal_create_node" }] } },
    }, "tools/list").ok).toBe(false);
    expect(classifyMcpJsonRpc({
      status: 200,
      json: { result: { isError: true } },
    }, "tools/call").ok).toBe(false);
    expect(classifyMcpJsonRpc({
      status: 200,
      json: { error: { code: -32000, message: "denied" } },
    }, "initialize").ok).toBe(false);
  });

  it("refuses a write-shaped tools/call before any request is sent", () => {
    expect(() => assertReadOnlyTool("drupal_create_node")).toThrow(/read-only/);
    expect(() => assertReadOnlyTool("drupal_entity_create")).toThrow(/read-only/);
    expect(() => assertReadOnlyTool("drupal_draft_nested_components")).toThrow(/read-only/);
    expect(() => assertReadOnlyTool("drupal_drush_cache_rebuild")).toThrow(/read-only/);
    expect(() => assertReadOnlyTool(READ_TOOL)).not.toThrow();
    expect(advertisedWriteLikeTools([
      { name: READ_TOOL },
      { name: "drupal_entity_create" },
      { name: "drupal_draft_nested_components" },
      { name: "drupal_drush_cron" },
    ])).toEqual([
      "drupal_entity_create",
      "drupal_draft_nested_components",
      "drupal_drush_cron",
    ]);
  });
});

describe("hosted client inventory", () => {
  it("covers every hosted public Origin and allowlists Claude at the edge", () => {
    const allow = resolveAllowOrigins();
    for (const origin of HOSTED_PUBLIC_CLIENT_ORIGINS) {
      expect(allow).toContain(origin);
    }
    expect(allow).toContain(CLAUDE_BROWSER_ORIGIN);
    expect(DENY_ORIGINS).toEqual([FOREIGN_ORIGIN, FOREIGN_LOOKALIKE_ORIGIN]);
    expect(DENY_ORIGINS).not.toContain(CLAUDE_BROWSER_ORIGIN);
    expect(CLIENT_INVENTORY.find((client) => client.id === "cursor").clientId).toBe(CURSOR_CLIENT_ID);
    expect(CLIENT_INVENTORY.find((client) => client.id === "grok").clientId).toBe(GROK_CLIENT_ID);
    const claude = CLIENT_INVENTORY.find((client) => client.id === "claude");
    expect(claude.clientId).toBe(CLAUDE_HOSTED_CIMD_URL);
    expect(claude.clientId).not.toBe("claude");
    expect(claude.acceptRedirects).toContain(CLAUDE_HOSTED_REDIRECT);
    expect(CLAUDE_CODE_CIMD_URL).toMatch(/claude-code-client-metadata/);
    expect(declaredClientIds()).not.toContain(CLAUDE_CODE_CIMD_URL);
    expect(DEFAULT_HOSTS.map((host) => host.id)).toEqual(["staging", "production"]);
  });

  it("derives authorize expects from the provisioned flag instead of hard-coding client_not_found", () => {
    const pending = resolveClientInventory(false);
    const grokPending = pending.find((client) => client.id === "grok");
    const claudePending = pending.find((client) => client.id === "claude");
    expect(grokPending.cimdAcceptExpect).toBe("client_not_found");
    expect(grokPending.cimdRejectExpect).toBe("client_not_found");
    expect(claudePending.inRealm).toBe(false);
    expect(claudePending.acceptExpect).toBe("client_not_found");
    expect(claudePending.rejectExpect).toBe("client_not_found");
    expect(pending.find((client) => client.id === "cursor").acceptExpect).toBe("login");

    const live = resolveClientInventory(true);
    const grokLive = live.find((client) => client.id === "grok");
    const claudeLive = live.find((client) => client.id === "claude");
    expect(grokLive.cimdAcceptExpect).toBe("login");
    expect(grokLive.cimdRejectExpect).toBe("invalid_redirect");
    expect(claudeLive.inRealm).toBe(true);
    expect(claudeLive.acceptExpect).toBe("login");
    expect(claudeLive.rejectExpect).toBe("invalid_redirect");
  });

  it("reads the provisioned flag from CLI then env, defaulting to not provisioned", () => {
    expect(resolveClientsProvisioned({}, {})).toBe(false);
    expect(resolveClientsProvisioned({ HOSTED_MCP_CLIENTS_PROVISIONED: "1" }, {})).toBe(true);
    expect(resolveClientsProvisioned({ HOSTED_MCP_CLIENTS_PROVISIONED: "0" }, {})).toBe(false);
    expect(resolveClientsProvisioned({ HOSTED_MCP_CLIENTS_PROVISIONED: "0" }, { clientsProvisioned: true }))
      .toBe(true);
    expect(resolveClientsProvisioned({ HOSTED_MCP_CLIENTS_PROVISIONED: "1" }, { clientsProvisioned: false }))
      .toBe(false);
    expect(() => resolveClientsProvisioned({ HOSTED_MCP_CLIENTS_PROVISIONED: "maybe" }, {}))
      .toThrow(/HOSTED_MCP_CLIENTS_PROVISIONED/);
  });

  it("parses WWW-Authenticate quoted params", () => {
    const parsed = parseWwwAuthenticate(
      "Bearer realm=\"mcp\", error=\"invalid_token\", resource_metadata=\"https://mcp.example/mcp/.well-known\"",
    );
    expect(parsed.scheme).toBe("Bearer");
    expect(parsed.params.error).toBe("invalid_token");
    expect(parsed.params.resource_metadata).toBe("https://mcp.example/mcp/.well-known");
  });
});

describe("runAcceptance with a fake fetch", () => {
  const token = "lab-token-value-not-for-logs";
  const secret = "lab-client-secret-not-for-logs";

  function fakeFetchFactory({
    dcrStatus = 403,
    mcpNoTokenStatus = 401,
    clientsProvisioned = false,
    allowOrigins = resolveAllowOrigins(),
  } = {}) {
    return async (url, init = {}) => {
      const href = String(url);
      const method = String(init.method || "GET").toUpperCase();
      const origin = init.headers?.origin;
      if (href.endsWith("/health")) {
        return jsonResponse(200, { status: "ok" });
      }
      if (href.includes("oauth-protected-resource")) {
        const resource = href.includes("staging")
          ? "https://mcp.staging.wilkesliberty.com/mcp"
          : "https://mcp.wilkesliberty.com/mcp";
        return jsonResponse(200, {
          resource,
          authorization_servers: [ISSUER],
          scopes_supported: ["mcp_read"],
        });
      }
      if (href.includes("openid-configuration")) {
        return jsonResponse(200, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
          token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "mcp_read"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }
      if (href === GROK_CIMD_URL) {
        return jsonResponse(200, {
          client_id: GROK_CIMD_URL,
          token_endpoint_auth_method: "none",
          redirect_uris: [
            "https://grok.com/connectors-oauth-exchange-code/",
            "https://console.x.ai/connectors-oauth-exchange-code/",
          ],
        });
      }
      if (href.includes("clients-registrations")) {
        return jsonResponse(dcrStatus, {
          error: "insufficient_scope",
          error_description: "Policy 'Trusted Hosts' rejected request. Host not trusted.",
        });
      }
      if (href.includes("/protocol/openid-connect/auth")) {
        const parsed = new URL(href);
        const clientId = parsed.searchParams.get("client_id");
        const redirect = parsed.searchParams.get("redirect_uri");
        const login = () => jsonResponse(200, "const kcContext = {\"pageId\": \"login-username\"};");
        const unknown = () => jsonResponse(400, "{\"pageId\":\"error\"}", {
          "set-cookie": `KC_STATE_CHECKER=${jwt({ mky: "clientNotFoundMessage", mpar: [] })}`,
        });
        const badRedirect = () => jsonResponse(400, "{\"pageId\":\"error\"}", {
          "set-cookie": `KC_STATE_CHECKER=${jwt({ mky: "invalidParameterMessage", mpar: ["redirect_uri"] })}`,
        });
        const allowedByClient = {
          [CURSOR_CLIENT_ID]: [
            "https://www.cursor.com/agents/mcp/oauth/callback",
            "http://localhost:8787/callback",
          ],
          [GROK_CLIENT_ID]: [
            "https://grok.com/connectors-oauth-exchange-code/",
            "https://console.x.ai/connectors-oauth-exchange-code/",
            "https://www.cursor.com/agents/mcp/oauth/callback",
          ],
          [GROK_CIMD_URL]: [
            "https://grok.com/connectors-oauth-exchange-code/",
            "https://console.x.ai/connectors-oauth-exchange-code/",
            "https://www.cursor.com/agents/mcp/oauth/callback",
          ],
          [CLAUDE_HOSTED_CIMD_URL]: [CLAUDE_HOSTED_REDIRECT],
        };
        const known = Object.hasOwn(allowedByClient, clientId);
        const applied = clientId === CLAUDE_HOSTED_CIMD_URL || clientId === GROK_CIMD_URL
          ? clientsProvisioned
          : known;
        if (!applied) return unknown();
        if ((allowedByClient[clientId] || []).includes(redirect)) return login();
        return badRedirect();
      }
      if (href.includes("/protocol/openid-connect/token")) {
        return jsonResponse(200, { access_token: token, token_type: "Bearer", expires_in: 300 });
      }
      if (href.endsWith("/mcp") && method === "OPTIONS") {
        if (origin && !allowOrigins.includes(origin)) {
          return jsonResponse(403, "Forbidden");
        }
        return jsonResponse(204, "");
      }
      if (href.endsWith("/mcp") && method === "POST") {
        if (origin && !allowOrigins.includes(origin)) {
          return jsonResponse(403, "Forbidden");
        }
        const auth = String(init.headers?.authorization || "");
        if (!auth.startsWith("Bearer ")) {
          return jsonResponse(mcpNoTokenStatus, "Unauthorized", {
            "www-authenticate": `Bearer realm="mcp", error="invalid_token", resource_metadata="${href.replace(/\/mcp$/, "")}/.well-known/oauth-protected-resource/mcp"`,
          });
        }
        if (auth === "Bearer not-a-real-token") {
          return jsonResponse(401, "Unauthorized", {
            "www-authenticate": "Bearer error=\"invalid_token\", error_description=\"Token is not active\"",
          });
        }
        const body = JSON.parse(String(init.body || "{}"));
        if (body.method === "initialize") {
          return jsonResponse(200, { result: { protocolVersion: "2026-07-28" } });
        }
        if (body.method === "tools/list") {
          return jsonResponse(200, { result: { tools: [{ name: READ_TOOL }] } });
        }
        if (body.method === "tools/call") {
          return jsonResponse(200, { result: { content: [{ type: "text", text: "types" }] } });
        }
      }
      return jsonResponse(404, "");
    };
  }

  it("passes the unauthenticated suite against a faithful fake", async () => {
    const report = await runAcceptance({
      fetchImpl: fakeFetchFactory(),
      env: {},
      now: () => "2026-10-18 01:40:00 EDT",
      sleep: noopSleep,
    });
    expect(report.ok).toBe(true);
    expect(report.clientsProvisioned).toBe(false);
    expect(report.origins).toContain(CLAUDE_BROWSER_ORIGIN);
    expect(report.denyOrigins).toEqual([FOREIGN_ORIGIN, FOREIGN_LOOKALIKE_ORIGIN]);
    expect(report.hosts).toHaveLength(2);
    expect(report.hosts[0].skipped).toBeGreaterThan(0);
    const markdown = formatMarkdown(report);
    expect(markdown).toContain("| health |");
    expect(markdown).toContain("## staging (");
    expect(markdown).toContain("## production (");
    expect(markdown).not.toContain("## undefined");
    expect(markdown).toContain("Client inventory: not provisioned");
    expect(markdown).toContain(`Overall: ${formatOverallLine(report)}`);
    expect(formatOverallLine(report)).toMatch(/PASS \(\d+ security gates skipped\)/);
    expect(countSkippedSecurityGates(report)).toBeGreaterThan(0);
    expect(markdown).toContain("PASS");
    expect(markdown).toContain("SKIP");
    expect(markdown).not.toContain(token);
    expect(redactSecrets("401 challenge resource_metadata=https://mcp.example/.well-known/oauth-protected-resource/mcp")).toContain("resource_metadata=https://mcp.example");
    const claudeAllow = report.hosts[0].steps.find((step) => step.id === `origin-allow:${CLAUDE_BROWSER_ORIGIN}`);
    expect(claudeAllow.ok).toBe(true);
    const claudePreflight = report.hosts[0].steps.find((step) => step.id === `origin-preflight:${CLAUDE_BROWSER_ORIGIN}`);
    expect(claudePreflight.ok).toBe(true);
    const gates = report.hosts[0].steps.filter((step) => step.id.startsWith("authorize-gates:"));
    expect(gates.length).toBe(CLIENT_INVENTORY.length);
    expect(gates.every((step) => step.skipped)).toBe(true);
  });

  it("passes the provisioned inventory when keystone#1559 clients accept their redirects", async () => {
    const report = await runAcceptance({
      fetchImpl: fakeFetchFactory({ clientsProvisioned: true }),
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
      clientsProvisioned: true,
    });
    expect(report.ok).toBe(true);
    expect(report.clientsProvisioned).toBe(true);
    expect(formatMarkdown(report)).toContain("Client inventory: provisioned");
    const steps = report.hosts[0].steps;
    expect(steps.find((step) => step.id === `authorize-cimd:${GROK_CIMD_URL}`).ok).toBe(true);
    expect(steps.find((step) => step.id.startsWith("authorize-cimd-reject:")).ok).toBe(true);
    expect(steps.find((step) => (
      step.id === `authorize-accept:${CLAUDE_HOSTED_CIMD_URL}:${CLAUDE_HOSTED_REDIRECT}`
    )).ok).toBe(true);
    expect(steps.find((step) => (
      step.id === `authorize-reject:${CLAUDE_HOSTED_CIMD_URL}:https://evil.example/callback`
    )).ok).toBe(true);
  });

  it("fails the run when unauthenticated /mcp starts returning 200", async () => {
    const report = await runAcceptance({
      fetchImpl: fakeFetchFactory({ mcpNoTokenStatus: 200 }),
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === "mcp-no-token").ok).toBe(false);
  });

  it("fails the run when a foreign Origin is allowed through", async () => {
    const inner = fakeFetchFactory();
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith("/mcp") && init.headers?.origin === FOREIGN_ORIGIN) {
        return jsonResponse(200, { result: { protocolVersion: "2026-07-28" } });
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === `origin-deny:${FOREIGN_ORIGIN}`).ok).toBe(false);
  });

  it("fails the run when a lookalike Origin is allowed through", async () => {
    const inner = fakeFetchFactory();
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith("/mcp") && String(init.method || "GET").toUpperCase() === "POST"
        && init.headers?.origin === FOREIGN_LOOKALIKE_ORIGIN) {
        return jsonResponse(401, "Unauthorized", {
          "www-authenticate": "Bearer resource_metadata=\"https://mcp.staging.wilkesliberty.com/.well-known/oauth-protected-resource/mcp\"",
        });
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === `origin-deny:${FOREIGN_LOOKALIKE_ORIGIN}`).ok)
      .toBe(false);
  });

  it("fails the run when foreign Origin OPTIONS is allowed through", async () => {
    const inner = fakeFetchFactory();
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith("/mcp") && String(init.method || "").toUpperCase() === "OPTIONS"
        && init.headers?.origin === FOREIGN_ORIGIN) {
        return jsonResponse(204, "");
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === `origin-deny-options:${FOREIGN_ORIGIN}`).ok)
      .toBe(false);
  });

  it("fails the run when allowlisted Origin OPTIONS loses 204", async () => {
    const inner = fakeFetchFactory();
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith("/mcp") && String(init.method || "").toUpperCase() === "OPTIONS"
        && init.headers?.origin === CLAUDE_BROWSER_ORIGIN) {
        return jsonResponse(403, "Forbidden");
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === `origin-preflight:${CLAUDE_BROWSER_ORIGIN}`).ok)
      .toBe(false);
  });

  it("fails the run when a junk bearer is accepted", async () => {
    const inner = fakeFetchFactory();
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith("/mcp") && init.headers?.authorization === "Bearer not-a-real-token") {
        return jsonResponse(200, { result: { protocolVersion: "2026-07-28" } });
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === "mcp-junk-token").ok).toBe(false);
  });

  it("fails the run when an unregistered redirect is accepted", async () => {
    const inner = fakeFetchFactory();
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/protocol/openid-connect/auth")) {
        const parsed = new URL(String(url));
        if (parsed.searchParams.get("redirect_uri") === "https://evil.example/callback"
          && parsed.searchParams.get("client_id") === CURSOR_CLIENT_ID) {
          return jsonResponse(200, "const kcContext = {\"pageId\": \"login-username\"};");
        }
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => (
      step.id === "authorize-reject:cursor-mcp:https://evil.example/callback"
    )).ok).toBe(false);
  });

  it("fails the run when a not-provisioned CIMD client_id starts resolving", async () => {
    const inner = fakeFetchFactory({ clientsProvisioned: false });
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/protocol/openid-connect/auth")) {
        const parsed = new URL(String(url));
        if (parsed.searchParams.get("client_id") === GROK_CIMD_URL) {
          return jsonResponse(200, "const kcContext = {\"pageId\": \"login-username\"};");
        }
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
      clientsProvisioned: false,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === `authorize-cimd:${GROK_CIMD_URL}`).ok)
      .toBe(false);
  });

  it("fails the run when a provisioned registered redirect is client_not_found", async () => {
    const inner = fakeFetchFactory({ clientsProvisioned: true });
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/protocol/openid-connect/auth")) {
        const parsed = new URL(String(url));
        if (parsed.searchParams.get("client_id") === CLAUDE_HOSTED_CIMD_URL
          && parsed.searchParams.get("redirect_uri") === CLAUDE_HOSTED_REDIRECT) {
          return jsonResponse(400, "{\"pageId\":\"error\"}", {
            "set-cookie": `KC_STATE_CHECKER=${jwt({ mky: "clientNotFoundMessage", mpar: [] })}`,
          });
        }
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
      clientsProvisioned: true,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => (
      step.id === `authorize-accept:${CLAUDE_HOSTED_CIMD_URL}:${CLAUDE_HOSTED_REDIRECT}`
    )).ok).toBe(false);
  });

  it("fails the run when a provisioned CIMD unregistered redirect is accepted", async () => {
    const inner = fakeFetchFactory({ clientsProvisioned: true });
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/protocol/openid-connect/auth")) {
        const parsed = new URL(String(url));
        if (parsed.searchParams.get("client_id") === GROK_CIMD_URL
          && parsed.searchParams.get("redirect_uri") === "https://evil.example/callback") {
          return jsonResponse(200, "const kcContext = {\"pageId\": \"login-username\"};");
        }
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
      clientsProvisioned: true,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => (
      step.id === `authorize-cimd-reject:${GROK_CIMD_URL}:https://evil.example/callback`
    )).ok).toBe(false);
  });

  it("fails the run when a provisioned unregistered redirect is accepted", async () => {
    const inner = fakeFetchFactory({ clientsProvisioned: true });
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/protocol/openid-connect/auth")) {
        const parsed = new URL(String(url));
        if (parsed.searchParams.get("client_id") === CLAUDE_HOSTED_CIMD_URL
          && parsed.searchParams.get("redirect_uri") === "https://evil.example/callback") {
          return jsonResponse(200, "const kcContext = {\"pageId\": \"login-username\"};");
        }
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
      clientsProvisioned: true,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => (
      step.id === `authorize-reject:${CLAUDE_HOSTED_CIMD_URL}:https://evil.example/callback`
    )).ok).toBe(false);
  });

  it("fails the run when a deny token is accepted", async () => {
    const inner = fakeFetchFactory();
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith("/mcp") && init.headers?.authorization === "Bearer shaped-deny") {
        return jsonResponse(200, { result: { protocolVersion: "2026-07-28" } });
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: { HOSTED_MCP_TOKEN_WRONG_AUDIENCE: "shaped-deny" },
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === "deny-token:wrong-audience").ok).toBe(false);
  });

  it("fails the run when the authorize page exposes consent off", async () => {
    const inner = fakeFetchFactory();
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/protocol/openid-connect/auth")) {
        const parsed = new URL(String(url));
        if (parsed.searchParams.get("client_id") === CURSOR_CLIENT_ID
          && parsed.searchParams.get("redirect_uri") === "https://www.cursor.com/agents/mcp/oauth/callback") {
          return jsonResponse(200, JSON.stringify({
            pageId: "login-username",
            consentRequired: false,
            staffGate: true,
          }));
        }
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === "authorize-gates:cursor-mcp").ok).toBe(false);
  });

  it("fails the run when anonymous DCR starts succeeding", async () => {
    const report = await runAcceptance({
      fetchImpl: fakeFetchFactory({ dcrStatus: 200 }),
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === "dcr-closed").ok).toBe(false);
  });

  it("exchanges a documented client_credentials identity without leaking the secret", async () => {
    const env = { HOSTED_MCP_CLIENT_SECRET: secret };
    const chunks = [];
    const inner = fakeFetchFactory();
    let tokenBody = "";
    const fetchImpl = async (url, init = {}) => {
      if (String(url).includes("/protocol/openid-connect/token")) {
        tokenBody = String(init.body || "");
      }
      return inner(url, init);
    };
    const code = await main(["--host", "staging", "--json"], {
      fetchImpl,
      env,
      sleep: noopSleep,
      stdout: { write: (chunk) => chunks.push(chunk) },
      stderr: { write: () => {} },
    });
    const printed = chunks.join("");
    expect(code).toBe(0);
    expect(printed).not.toContain(secret);
    expect(printed).not.toContain(token);
    expect(printed).toContain("\"id\": \"signed-in:tools/call\"");
    expect(printed).toContain("\"ok\": true");
    expect(tokenBody).toContain("resource=https%3A%2F%2Fmcp.staging.wilkesliberty.com%2Fmcp");
    expect(tokenBody).toContain("scope=mcp_read");
    expect(printed).not.toContain("client_secret");
  });

  it("retries a 429 authorize and then classifies the login page", async () => {
    let authCalls = 0;
    const fetchImpl = fakeFetchFactory();
    const wrapped = async (url, init) => {
      if (String(url).includes("/protocol/openid-connect/auth") && authCalls < 1) {
        authCalls += 1;
        return jsonResponse(429, "rate limited", { "retry-after": "1" });
      }
      return fetchImpl(url, init);
    };
    const waited = [];
    const report = await runAcceptance({
      fetchImpl: wrapped,
      env: {},
      hosts: [DEFAULT_HOSTS[0]],
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    expect(report.ok).toBe(true);
    expect(authCalls).toBe(1);
    expect(waited.some((ms) => ms === 1000)).toBe(true);
  });

  it("returns 2 when --require-signed-in and no token is present", async () => {
    const code = await main(["--require-signed-in", "--host", "staging"], {
      fetchImpl: fakeFetchFactory(),
      env: {},
      sleep: noopSleep,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    expect(code).toBe(2);
  });

  it("returns 2 when --require-signed-in and consent or operators-gate steps are skipped", async () => {
    const stderr = [];
    const code = await main(["--require-signed-in", "--host", "staging"], {
      fetchImpl: fakeFetchFactory(),
      env: { HOSTED_MCP_TOKEN: token },
      sleep: noopSleep,
      stdout: { write: () => {} },
      stderr: { write: (chunk) => stderr.push(chunk) },
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toMatch(/operators staff gate/);
    expect(isSecurityGateStep({ id: "authorize-gates:cursor-mcp" })).toBe(true);
    expect(isRequiredSignedInStep({ id: "authorize-gates:cursor-mcp" })).toBe(true);
    expect(isRequiredSignedInStep({ id: "signed-in:initialize" })).toBe(true);
    expect(isRequiredSignedInStep({ id: "health" })).toBe(false);
  });

  it("fails the run when tools/list advertises a write tool", async () => {
    const inner = fakeFetchFactory();
    let writeCallSent = false;
    const fetchImpl = async (url, init = {}) => {
      const href = String(url);
      const parsed = (() => {
        try {
          return JSON.parse(String(init.body || "{}"));
        } catch {
          return {};
        }
      })();
      if (href.endsWith("/mcp") && parsed.method === "tools/list") {
        return jsonResponse(200, {
          result: { tools: [{ name: READ_TOOL }, { name: "drupal_create_node" }] },
        });
      }
      if (href.endsWith("/mcp") && parsed.method === "tools/call") {
        if (parsed.params?.name && parsed.params.name !== READ_TOOL) {
          writeCallSent = true;
        }
      }
      return inner(url, init);
    };
    const report = await runAcceptance({
      fetchImpl,
      env: { HOSTED_MCP_TOKEN: token },
      hosts: [DEFAULT_HOSTS[1]],
      sleep: noopSleep,
    });
    expect(report.ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === "signed-in:tools/list").ok).toBe(false);
    expect(report.hosts[0].steps.find((step) => step.id === "signed-in:tools/list").reason)
      .toMatch(/drupal_create_node/);
    expect(writeCallSent).toBe(false);
  });

  it("refuses to print when an env secret appears in the report", async () => {
    const stderr = [];
    let printed = false;
    const code = await main(["--host", "staging"], {
      fetchImpl: fakeFetchFactory(),
      env: { HOSTED_MCP_TOKEN: "https://mcp.staging.wilkesliberty.com/mcp" },
      sleep: noopSleep,
      stdout: {
        write: () => {
          printed = true;
        },
      },
      stderr: { write: (chunk) => stderr.push(chunk) },
    });
    expect(code).toBe(1);
    expect(printed).toBe(false);
    expect(stderr.join("")).toMatch(/refused to print/);
  });
});

describe("CLI wiring", () => {
  it("parses host, json, require-signed-in, and the client-inventory flag", () => {
    const args = parseArgs(["--host", "production", "--json", "--require-signed-in", "--clients-provisioned"]);
    expect(args.json).toBe(true);
    expect(args.requireSignedIn).toBe(true);
    expect(args.clientsProvisioned).toBe(true);
    expect(args.hosts).toEqual([DEFAULT_HOSTS[1]]);
    expect(parseArgs(["--clients-not-provisioned"]).clientsProvisioned).toBe(false);
    expect(() => parseArgs(["--host", "lab"])).toThrow(/unknown --host/);
    expect(() => parseArgs(["--clients-provisioned", "--clients-not-provisioned"]))
      .toThrow(/only one/);
  });

  it("prints help without fetching", async () => {
    const chunks = [];
    const code = await main(["--help"], {
      fetchImpl: async () => {
        throw new Error("help must not fetch");
      },
      stdout: { write: (chunk) => chunks.push(chunk) },
    });
    expect(code).toBe(0);
    expect(chunks.join("")).toMatch(/DEV-953/);
  });

  it("caps Retry-After and falls back to exponential backoff", () => {
    expect(retryAfterMs({ headers: { "retry-after": "2" } }, 0)).toBe(2000);
    expect(retryAfterMs({ headers: { "retry-after": "99" } }, 0)).toBe(15_000);
    expect(retryAfterMs({ headers: {} }, 0)).toBe(400);
    expect(retryAfterMs({ headers: {} }, 3)).toBe(3200);
  });

  it("gates every documented token alias against report print", () => {
    expect(SECRET_ENV).toEqual(expect.arrayContaining([
      "HOSTED_MCP_TOKEN",
      "HOSTED_MCP_TOKEN_STAGING",
      "HOSTED_MCP_TOKEN_PRODUCTION",
      "HOSTED_MCP_TOKEN_WRONG_AUDIENCE",
      "HOSTED_MCP_TOKEN_EXPIRED",
      "HOSTED_MCP_TOKEN_INSUFFICIENT_SCOPE",
      "HOSTED_MCP_CLIENT_SECRET",
      "EVAL_HTTP_STAGING_TOKEN_READ",
      "EVAL_HTTP_STAGING_TOKEN_WRONG_AUDIENCE",
      "EVAL_HTTP_STAGING_TOKEN_EXPIRED",
      "EVAL_HTTP_STAGING_TOKEN_INSUFFICIENT_SCOPE",
    ]));
  });

  it("does not default a production token onto staging", () => {
    const staging = readTokenConfig({ HOSTED_MCP_TOKEN_PRODUCTION: "prod-only" }, "staging");
    expect(staging.read).toBe("");
    const production = readTokenConfig({ HOSTED_MCP_TOKEN_PRODUCTION: "prod-only" }, "production");
    expect(production.read).toBe("prod-only");
  });

  it("does not apply staging eval token aliases to production", () => {
    const env = {
      EVAL_HTTP_STAGING_TOKEN_READ: "staging-read-only",
      EVAL_HTTP_STAGING_TOKEN_WRONG_AUDIENCE: "staging-wrong-aud",
      EVAL_HTTP_STAGING_TOKEN_EXPIRED: "staging-expired",
      EVAL_HTTP_STAGING_TOKEN_INSUFFICIENT_SCOPE: "staging-scope",
    };
    const production = readTokenConfig(env, "production");
    expect(production.read).toBe("");
    expect(production.wrongAudience).toBe("");
    expect(production.expired).toBe("");
    expect(production.insufficientScope).toBe("");
    const staging = readTokenConfig(env, "staging");
    expect(staging.read).toBe("staging-read-only");
    expect(staging.wrongAudience).toBe("staging-wrong-aud");
    expect(staging.expired).toBe("staging-expired");
    expect(staging.insufficientScope).toBe("staging-scope");
  });
});

describe("docs and package wiring", () => {
  it("advertises the probe next to the staging eval pack", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["eval:hosted"]).toBe("node scripts/hosted-acceptance.js");
    expect(read("AGENTS.md")).toContain("npm run eval:hosted");
    expect(read("docs/mcp-clients.md")).toContain("npm run eval:hosted");
    expect(read("CHANGELOG.md")).toMatch(/eval:hosted/);
  });

  it("names the keystone#1564 operators staff gate on the deny flow", () => {
    expect(AUTHORIZE_GATES_EXPECT).toBe("consent+operators-gate");
    expect(OPERATORS_STAFF_GATE).toContain(OPERATORS_STAFF_ROLE);
    expect(OPERATORS_STAFF_GATE).toContain(OPERATORS_DENY_FLOW);
    for (const rel of [
      "scripts/hosted-acceptance.js",
      "docs/mcp-clients.md",
      "CHANGELOG.md",
    ]) {
      const text = read(rel);
      expect(text, rel).toContain(OPERATORS_STAFF_ROLE);
      expect(text, rel).toContain(OPERATORS_DENY_FLOW);
    }
  });

  it("fails if an inventory client_id is missing from the vendored keystone list", () => {
    const fixture = JSON.parse(read("tests/fixtures/keystone-mcp-clients.json"));
    expect(fixture.source.repository).toBe("https://github.com/Wilkes-Liberty/keystone");
    expect(fixture.source.refs).toEqual(expect.arrayContaining([
      "https://github.com/Wilkes-Liberty/keystone/pull/1539",
      "https://github.com/Wilkes-Liberty/keystone/pull/1559",
      "https://github.com/Wilkes-Liberty/keystone/pull/1564",
    ]));
    const listed = new Set(fixture.clients.map((client) => client.clientId));
    for (const id of declaredClientIds()) {
      expect(listed.has(id), id).toBe(true);
    }
    const invented = [...declaredClientIds(), "invented-client"];
    expect(invented.every((id) => listed.has(id))).toBe(false);
  });
});
