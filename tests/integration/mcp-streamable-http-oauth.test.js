import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createResourceAuthenticator } from "../../src/lib/http-auth.js";
import { createLegacySessionHandler, createMcpRequestHandler } from "../../src/lib/http-handler.js";
import { resolveAllowedOrigins } from "../../src/lib/http-transport.js";
import { createConnectorServerFactory } from "../../src/lib/mcp-server.js";

const closers = [];

afterEach(async () => {
  while (closers.length) await closers.pop()();
});

const ISSUER = "https://idp.example.com";
const AUDIENCE = "https://mcp.example.com/mcp";

async function mintToken(privateKey, claims = {}) {
  return new SignJWT({ scope: "mcp_read", azp: "content-agent", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "e2e" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.sub ?? "agent-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function startOauthConnector() {
  const stub = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/vnd.api+json" });
    res.end(JSON.stringify({
      data: [{ type: "node--article", id: "1", attributes: { title: "oauth-canary" } }],
    }));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve, reject) => stub.close((error) => error ? reject(error) : resolve())));
  const upstream = `http://127.0.0.1:${stub.address().port}`;

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "e2e";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const authenticate = createResourceAuthenticator({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: createLocalJWKSet({ keys: [jwk] }),
    resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
  });

  const surface = {
    serverInfo: { name: "oauth-e2e", version: "1.0.0" },
    tools: {
      definitions: [{
        name: "drupal_list_nodes",
        description: "List nodes from the stub upstream",
        inputSchema: { type: "object", properties: {} },
      }],
      call: vi.fn(async () => {
        const res = await fetch(`${upstream}/jsonapi/node/article`);
        const json = await res.json();
        return { content: [{ type: "text", text: JSON.stringify(json) }] };
      }),
    },
    resources: { definitions: [], read: async () => ({}) },
    prompts: { definitions: [], get: () => [] },
  };
  const buildServer = createConnectorServerFactory(surface);
  const modern = createMcpHandler(buildServer, { legacy: "reject" });
  const handler = createMcpRequestHandler({
    authenticate: async (req) => authenticate(req.headers.authorization, req.headers),
    allowLocalOperator: false,
    modernHandler: toNodeHandler(modern),
    legacyHandler: createLegacySessionHandler({ buildServer, mode: "serve" }),
    allowedOrigins: resolveAllowedOrigins({ resource: AUDIENCE }),
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    await modern.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return {
    url: new URL(`http://127.0.0.1:${server.address().port}/mcp`),
    privateKey,
    callTool: surface.tools.call,
  };
}

describe("Streamable HTTP OAuth client (DEV-840)", () => {
  it.each(["2026-07-28", "2025-11-25"])(
    "distinguishes absent credentials from rejected tokens over HTTP (%s)",
    async (protocolVersion) => {
      const { url, callTool } = await startOauthConnector();
      const metadata = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
      const plainChallenge = `Bearer realm="mcp", resource_metadata="${metadata}"`;
      for (const authorization of [undefined, "Basic c3ludGhldGljOnRlc3Q=", "Bearer invalid-token"]) {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": protocolVersion,
            ...(authorization ? { authorization } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "drupal_list_nodes", arguments: {} },
          }),
        });
        expect(response.status).toBe(401);
        const challenge = response.headers.get("www-authenticate");
        if (authorization?.startsWith("Bearer ")) {
          expect(challenge).toContain('error="invalid_token"');
          expect(challenge).toContain(`resource_metadata="${metadata}"`);
        } else {
          expect(challenge).toBe(plainChallenge);
        }
        expect(await response.text()).toBe("Unauthorized");
        expect(callTool).not.toHaveBeenCalled();
      }
    },
  );

  it("connects with a bearer token, lists tools, and calls one against a stub upstream", async () => {
    const { url, privateKey } = await startOauthConnector();
    const token = await mintToken(privateKey);
    const client = new Client(
      { name: "oauth-e2e-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    closers.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(url, {
      authProvider: { token: async () => token },
    }));

    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["drupal_list_nodes"]);
    const called = await client.callTool({ name: "drupal_list_nodes", arguments: {} });
    expect(called.content[0].text).toContain("oauth-canary");
  });

  it("returns 202 for a legacy initialized notification and 404 after DELETE", async () => {
    const { url, privateKey } = await startOauthConnector();
    const token = await mintToken(privateKey);
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    };
    const init = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-e2e", version: "1.0.0" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const notified = await fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe("");

    const closed = await fetch(url, {
      method: "DELETE",
      headers: { ...headers, "mcp-session-id": sessionId },
    });
    expect(closed.status).toBe(200);

    const expired = await fetch(url, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(expired.status).toBe(404);
  });
});
