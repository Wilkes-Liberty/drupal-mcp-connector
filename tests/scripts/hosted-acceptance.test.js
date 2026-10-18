import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOSTED_PUBLIC_CLIENT_ORIGINS } from "../../src/lib/http-transport.js";
import {
  CLAUDE_HOSTED_REDIRECT,
  CLIENT_PATHS,
  CURSOR_CLIENT_ID,
  DEFAULT_HOSTS,
  GROK_CIMD_URL,
  GROK_CLIENT_ID,
  ISSUER,
  READ_TOOL,
  SECRET_ENV,
  assertReadOnlyTool,
  classifyAsMetadata,
  classifyAuthorize,
  classifyDcrClosed,
  classifyGrokCimd,
  classifyHealth,
  classifyMcpJsonRpc,
  classifyOriginRefused,
  classifyProtectedResource,
  classifyUnauthenticatedMcp,
  isExactIssuer,
  decodeJwtPayload,
  formatEt,
  formatMarkdown,
  main,
  parseArgs,
  parseAuthorizeResponse,
  parseWwwAuthenticate,
  readTokenConfig,
  redactSecrets,
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

  it("redacts bearer tokens, JWTs, and client_secret assignments", () => {
    const jwtValue = jwt({ sub: "lab" });
    const raw = `Authorization: Bearer ${jwtValue} client_secret=super-secret-value`;
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain("super-secret-value");
    expect(redacted).not.toContain(jwtValue);
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
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
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
      json: { result: { isError: true } },
    }, "tools/call").ok).toBe(false);
    expect(classifyMcpJsonRpc({
      status: 200,
      json: { error: { code: -32000, message: "denied" } },
    }, "initialize").ok).toBe(false);
  });

  it("refuses a write-shaped tools/call before any request is sent", () => {
    expect(() => assertReadOnlyTool("drupal_create_node")).toThrow(/read-only/);
    expect(() => assertReadOnlyTool(READ_TOOL)).not.toThrow();
  });
});

describe("hosted client path table", () => {
  it("covers every hosted public Origin and keeps Grok on the short client id", () => {
    const listed = CLIENT_PATHS.flatMap((client) => [...client.origins]);
    for (const origin of HOSTED_PUBLIC_CLIENT_ORIGINS) {
      expect(listed).toContain(origin);
    }
    expect(CLIENT_PATHS.find((client) => client.id === "cursor").clientId).toBe(CURSOR_CLIENT_ID);
    expect(CLIENT_PATHS.find((client) => client.id === "grok").clientId).toBe(GROK_CLIENT_ID);
    expect(CLIENT_PATHS.find((client) => client.id === "grok").cimdClientIdExpect).toBe("client_not_found");
    expect(CLIENT_PATHS.find((client) => client.id === "claude").originExpect).toBe("refuse");
    expect(CLIENT_PATHS.find((client) => client.id === "claude").rejectRedirects).toContain(CLAUDE_HOSTED_REDIRECT);
    expect(DEFAULT_HOSTS.map((host) => host.id)).toEqual(["staging", "production"]);
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

  function fakeFetchFactory({ dcrStatus = 403, mcpNoTokenStatus = 401 } = {}) {
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
        if (clientId === GROK_CIMD_URL || clientId === "claude") {
          return jsonResponse(400, "{\"pageId\":\"error\"}", {
            "set-cookie": `KC_STATE_CHECKER=${jwt({ mky: "clientNotFoundMessage", mpar: [] })}`,
          });
        }
        const allowed = [
          "https://www.cursor.com/agents/mcp/oauth/callback",
          "http://localhost:8787/callback",
          "https://grok.com/connectors-oauth-exchange-code/",
          "https://console.x.ai/connectors-oauth-exchange-code/",
        ];
        if (clientId === GROK_CLIENT_ID && redirect === "https://www.cursor.com/agents/mcp/oauth/callback") {
          return jsonResponse(200, "const kcContext = {\"pageId\": \"login-username\"}");
        }
        if (allowed.includes(redirect)) {
          return jsonResponse(200, "const kcContext = {\"pageId\": \"login-username\"}");
        }
        return jsonResponse(400, "{\"pageId\":\"error\"}", {
          "set-cookie": `KC_STATE_CHECKER=${jwt({ mky: "invalidParameterMessage", mpar: ["redirect_uri"] })}`,
        });
      }
      if (href.includes("/protocol/openid-connect/token")) {
        return jsonResponse(200, { access_token: token, token_type: "Bearer", expires_in: 300 });
      }
      if (href.endsWith("/mcp") && method === "POST") {
        if (origin && !HOSTED_PUBLIC_CLIENT_ORIGINS.includes(origin)) {
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
    expect(report.hosts).toHaveLength(2);
    expect(report.hosts[0].skipped).toBeGreaterThan(0);
    const markdown = formatMarkdown(report);
    expect(markdown).toContain("| health |");
    expect(markdown).toContain("## staging (");
    expect(markdown).toContain("## production (");
    expect(markdown).not.toContain("## undefined");
    expect(markdown).toContain("PASS");
    expect(markdown).toContain("SKIP");
    expect(markdown).not.toContain(token);
    expect(redactSecrets("401 challenge resource_metadata=https://mcp.example/.well-known/oauth-protected-resource/mcp")).toContain("resource_metadata=https://mcp.example");
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
      if (String(url).endsWith("/mcp") && init.headers?.origin === "https://evil.example") {
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
    expect(report.hosts[0].steps.find((step) => step.id === "origin-deny:https://evil.example").ok).toBe(false);
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
});

describe("CLI wiring", () => {
  it("parses host, json, and require-signed-in", () => {
    const args = parseArgs(["--host", "production", "--json", "--require-signed-in"]);
    expect(args.json).toBe(true);
    expect(args.requireSignedIn).toBe(true);
    expect(args.hosts).toEqual([DEFAULT_HOSTS[1]]);
    expect(() => parseArgs(["--host", "lab"])).toThrow(/unknown --host/);
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
});

describe("docs and package wiring", () => {
  it("advertises the probe next to the staging eval pack", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["eval:hosted"]).toBe("node scripts/hosted-acceptance.js");
    expect(read("AGENTS.md")).toContain("npm run eval:hosted");
    expect(read("docs/mcp-clients.md")).toContain("npm run eval:hosted");
    expect(read("CHANGELOG.md")).toMatch(/eval:hosted/);
  });
});
