/**
 * Edge/agent battery (#232) — the DEV-293 lab patterns upgraded with real
 * denies, run against product code (issue #232, DEV-294 AC4 slice).
 *
 * Every deny this battery names was watched failing before the code that
 * closes it existed: unauthenticated northbound, shared bearer, wrong
 * issuer/audience/expiry, missing scope, revoked jti, missing grant table,
 * unlisted client, cross-principal hint, rogue/revoked channel, credential
 * headers crossing the tunnel, and sessionful northbound traffic.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, utimesSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getRequestIdentity } from "../../src/lib/principal.js";
import { attachFramer, writeFrame } from "../../src/lib/relay/frames.js";
import {
  CALLER_CREDENTIAL_HEADERS,
  EDGE_MCP_PROTOCOL,
  EDGE_REVOCATION_BOUND,
  EdgeStartupError,
  createChannelCredentialStore,
  startEdge,
} from "../../src/lib/relay/edge.js";
import { createRelayAgent } from "../../src/lib/relay/agent.js";
import {
  AUDIENCE,
  ISSUER,
  createChannelFile,
  createConnectionLedger,
  createIssuerFixture,
  sha256hex,
  startRecordingStub,
} from "./support.js";

const SITES = [{ _name: "tenant-alpha" }, { _name: "tenant-beta" }];
const GRANTS = { "client-a": ["tenant-alpha"], "client-b": ["tenant-beta"] };

let issuer;
beforeAll(async () => {
  issuer = await createIssuerFixture();
});

const closers = [];
afterEach(async () => {
  while (closers.length) await closers.pop()();
});

function track(closeable) {
  closers.push(() => closeable.close());
  return closeable;
}

function baseEdgeOptions(overrides = {}) {
  return {
    auth: { issuer: ISSUER, audience: AUDIENCE },
    grants: GRANTS,
    sites: SITES,
    defaultSite: "tenant-alpha",
    channelCredentials: { lookup: () => null },
    allowHttpLoopback: true,
    fetchFn: (...args) => issuer.fetchFn(...args),
    ...overrides,
  };
}

async function startHarness({
  grants = GRANTS,
  requiredScopes,
  revocationFile,
} = {}) {
  const channel = createChannelFile();
  const token = `channel-${randomBytes(24).toString("hex")}`;
  channel.write({ "tenant-a": { tokenSha256: sha256hex(token) } });
  const ledger = createConnectionLedger();
  const edge = await startEdge(baseEdgeOptions({
    auth: {
      issuer: ISSUER,
      audience: AUDIENCE,
      ...(requiredScopes ? { requiredScopes } : {}),
      ...(revocationFile ? { revocationFile } : {}),
    },
    grants,
    channelCredentials: createChannelCredentialStore({ filePath: channel.filePath }),
    ledger,
  }));
  closers.push(() => edge.close());
  return { edge, channel, token, ledger };
}

function tenantSurface({ stub = null, siteCredential = "site-credential-tenant-only" } = {}) {
  const calls = [];
  let hold = null;
  const surface = {
    serverInfo: { name: "relay-tenant-test", version: "0.0.0-test" },
    tools: {
      definitions: [{
        name: "drupal_relay_echo",
        description: "Relay battery echo. Not a published connector tool.",
        inputSchema: {
          type: "object",
          properties: { hold: { type: "boolean" }, site: { type: "string" } },
        },
      }],
      call: async (_name, args = {}) => {
        const identity = getRequestIdentity();
        calls.push({ args, identity });
        if (args.hold && hold) {
          hold.startedResolve();
          await hold.waiting;
        }
        let southbound = null;
        if (stub) {
          const res = await fetch(`${stub.url}/jsonapi/relay-probe`, {
            headers: { authorization: `Bearer ${siteCredential}` },
          });
          southbound = res.status;
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ tenant: true, identity, southbound }) }],
        };
      },
    },
    resources: { definitions: [], read: async (uri) => ({ uri }) },
    prompts: { definitions: [], get: () => [] },
  };
  return {
    surface,
    calls,
    siteCredential,
    armHold() {
      let startedResolve = () => {};
      let release = () => {};
      const started = new Promise((resolve) => { startedResolve = resolve; });
      const waiting = new Promise((resolve) => { release = resolve; });
      hold = { started, waiting, startedResolve, release };
      return { started, release };
    },
  };
}

async function startRealAgent(harness, { stub = null, token = harness.token, siteCredential } = {}) {
  const tenant = tenantSurface({ stub, ...(siteCredential ? { siteCredential } : {}) });
  const agent = createRelayAgent({
    host: "127.0.0.1",
    port: harness.edge.agentPort,
    token,
    surface: tenant.surface,
    ledger: harness.ledger,
  });
  closers.push(() => agent.close());
  const hello = await agent.dial();
  expect(hello.ok).toBe(true);
  return { agent, tenant };
}

async function startTwoTenantHarness() {
  const channel = createChannelFile();
  const tokenA = `channel-a-${randomBytes(24).toString("hex")}`;
  const tokenB = `channel-b-${randomBytes(24).toString("hex")}`;
  channel.write({
    "tenant-a": { tokenSha256: sha256hex(tokenA), sites: ["tenant-alpha"] },
    "tenant-b": { tokenSha256: sha256hex(tokenB), sites: ["tenant-beta"] },
  });
  const ledger = createConnectionLedger();
  const edge = await startEdge(baseEdgeOptions({
    channelCredentials: createChannelCredentialStore({ filePath: channel.filePath }),
    ledger,
  }));
  closers.push(() => edge.close());
  return { edge, channel, tokenA, tokenB, ledger };
}

/** Raw framed channel: captures every frame the edge sends, answers 200. */
function connectRawAgent({ port, token, autoReply = true }) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      writeFrame(socket, { type: "hello", token });
    });
    closers.push(() => { socket.destroy(); });
    attachFramer(socket, (frame) => {
      frames.push(frame);
      if (frame.type === "hello-ok") {
        resolve({ socket, frames, denied: null });
      } else if (frame.type === "denied") {
        resolve({ socket, frames, denied: frame.reason });
      } else if (frame.type === "mcp-request" && autoReply) {
        writeFrame(socket, {
          type: "mcp-response",
          id: frame.id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }),
        });
      }
    });
    socket.on("error", reject);
  });
}

/** Modern-shaped POST with fully caller-controlled headers. */
function modernCall(url, jwt, { name = "drupal_relay_echo", args = {}, headers = {}, method = "tools/call" } = {}) {
  const target = new URL(url);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method,
    params: method === "tools/call" ? { name, arguments: args } : {},
  });
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        "MCP-Protocol-Version": EDGE_MCP_PROTOCOL,
        "Mcp-Method": method,
        ...(method === "tools/call" ? { "Mcp-Name": name } : {}),
        ...headers,
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function settle(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectModernClient(url, jwt, traffic) {
  const client = new Client(
    { name: "relay-northbound-test", version: "0.0.0-test" },
    { capabilities: { roots: {} }, versionNegotiation: { mode: "auto" } },
  );
  closers.push(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: { token: async () => jwt },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = request.method === "POST" ? await request.clone().json() : null;
      const response = await fetch(input, init);
      traffic.push({
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
        status: response.status,
        responseHeaders: Object.fromEntries(response.headers),
      });
      return response;
    },
  });
  return client.connect(transport).then(() => client);
}

function echoPayload(result) {
  const text = result.content.find((part) => part.type === "text")?.text;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------

describe("edge policy constants", () => {
  it("names the caller credential strip set (#229 parity) and the revocation bound", () => {
    expect([...CALLER_CREDENTIAL_HEADERS].sort()).toEqual([
      "authorization",
      "cookie",
      "proxy-authorization",
    ]);
    expect(EDGE_MCP_PROTOCOL).toBe("2026-07-28");
    expect(EDGE_REVOCATION_BOUND).toMatchObject({
      name: "per-request",
      graceMs: 0,
      appliesTo: ["northbound-principal", "agent-channel"],
    });
  });
});

describe("edge startup refuses (fail closed from birth)", () => {
  it("is fatal without issuer/audience at a loopback bind, shared token present or not", async () => {
    process.env.MCP_AUTH_TOKEN = "legacy-shared-secret";
    try {
      await expect(startEdge(baseEdgeOptions({ auth: {} })))
        .rejects.toThrow(EdgeStartupError);
      await expect(startEdge(baseEdgeOptions({ auth: { issuer: ISSUER } })))
        .rejects.toThrow(/issuer.*audience|audience/i);
      await expect(startEdge(baseEdgeOptions({ auth: { audience: AUDIENCE } })))
        .rejects.toThrow(/issuer/i);
    } finally {
      delete process.env.MCP_AUTH_TOKEN;
    }
  });

  it("refuses to start without a non-empty grant table", async () => {
    await expect(startEdge(baseEdgeOptions({ grants: undefined })))
      .rejects.toThrow(/grant/i);
    await expect(startEdge(baseEdgeOptions({ grants: {} })))
      .rejects.toThrow(/grant/i);
    await expect(startEdge(baseEdgeOptions({ grants: { _comment: ["doc-only"] } })))
      .rejects.toThrow(/grant/i);
  });

  it("refuses to start without a channel credential store", async () => {
    await expect(startEdge(baseEdgeOptions({ channelCredentials: null })))
      .rejects.toThrow(/channel credential/i);
  });

  it("refuses to start when a site descriptor carries credential material", async () => {
    for (const leak of [
      { apiToken: "site-token" },
      { username: "svc", password: "secret" },
      { oauth: { clientIdEnv: "X" } },
      { drushSsh: { host: "127.0.0.1" } },
    ]) {
      await expect(startEdge(baseEdgeOptions({
        sites: [{ _name: "tenant-alpha", ...leak }],
      }))).rejects.toThrow(/credential/i);
    }
  });

  it("refuses a network-facing bind without TLS", async () => {
    await expect(startEdge(baseEdgeOptions({ bindHost: "0.0.0.0" })))
      .rejects.toThrow(/TLS/);
  });

  it("control: starts with a full valid configuration and serves health + metadata", async () => {
    const harness = await startHarness();
    const health = await fetch(new URL("/health", harness.edge.northboundUrl));
    expect(health.status).toBe(200);
    const metadata = await fetch(
      new URL("/.well-known/oauth-protected-resource/mcp", harness.edge.northboundUrl),
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: AUDIENCE });
  });
});

describe("northbound auth is real, through the edge entry point", () => {
  it("denies an unauthenticated request with resource metadata", async () => {
    const harness = await startHarness();
    const denied = await modernCall(harness.edge.northboundUrl, null);
    expect(denied.status).toBe(401);
    expect(denied.headers["www-authenticate"]).toContain("resource_metadata=");
  });

  it("denies the environment's shared bearer even when it is set", async () => {
    process.env.MCP_AUTH_TOKEN = "legacy-shared-secret";
    try {
      const harness = await startHarness();
      const denied = await modernCall(harness.edge.northboundUrl, process.env.MCP_AUTH_TOKEN);
      expect(denied.status).toBe(401);
      expect(denied.headers["www-authenticate"]).toContain("invalid_token");
    } finally {
      delete process.env.MCP_AUTH_TOKEN;
    }
  });

  it("denies wrong issuer, wrong audience, and expired tokens", async () => {
    const harness = await startHarness();
    const wrongIssuer = await issuer.signToken({ issuer: "https://rogue-idp.test" });
    const wrongAudience = await issuer.signToken({ audience: "https://other.test/mcp" });
    const expired = await issuer.signToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    for (const jwt of [wrongIssuer, wrongAudience, expired]) {
      const denied = await modernCall(harness.edge.northboundUrl, jwt);
      expect(denied.status).toBe(401);
      expect(denied.headers["www-authenticate"]).toContain("invalid_token");
    }
  });

  it("denies a missing required scope with insufficient_scope", async () => {
    const harness = await startHarness({ requiredScopes: ["mcp_read"] });
    const scopeless = await issuer.signToken({ scope: "" });
    const denied = await modernCall(harness.edge.northboundUrl, scopeless);
    expect(denied.status).toBe(403);
    expect(denied.headers["www-authenticate"]).toContain("insufficient_scope");
  });

  it("denies a revoked jti without a restart", async () => {
    const channel = createChannelFile();
    const revocationFile = join(channel.dir, "revoked.json");
    const harness = await startHarness({ revocationFile });
    const { tenant } = await startRealAgent(harness);
    const jwt = await issuer.signToken({ jti: "j-revoked" });

    const traffic = [];
    const client = await connectModernClient(harness.edge.northboundUrl, jwt, traffic);
    const before = echoPayload(await client.callTool({
      name: "drupal_relay_echo",
      arguments: { site: "tenant-alpha" },
    }));
    expect(before.tenant).toBe(true);
    expect(tenant.calls).toHaveLength(1);

    writeFileSync(revocationFile, JSON.stringify({ jti: ["j-revoked"] }));
    utimesSync(revocationFile, 1_700_000_100, 1_700_000_100);
    const after = await modernCall(harness.edge.northboundUrl, jwt, {
      args: { site: "tenant-alpha" },
    });
    expect(after.status).toBe(401);
    expect(after.headers["www-authenticate"]).toContain("revoked");
  });
});

describe("entitlement at the seam", () => {
  it("denies an unlisted client with zero targets before any fan-down or tenant leak", async () => {
    const harness = await startHarness();
    const unlisted = await issuer.signToken({ clientId: "client-unlisted" });

    // No agent connected: an unlisted client still gets 403, not 503 —
    // whether a tenant exists is not revealed beyond the granted surface.
    const withoutAgent = await modernCall(harness.edge.northboundUrl, unlisted);
    expect(withoutAgent.status).toBe(403);
    expect(JSON.parse(withoutAgent.body)).toEqual({ error: "not_entitled" });

    const raw = await connectRawAgent({ port: harness.edge.agentPort, token: harness.token });
    const withAgent = await modernCall(harness.edge.northboundUrl, unlisted);
    expect(withAgent.status).toBe(403);
    await settle();
    expect(raw.frames.filter((frame) => frame.type === "mcp-request")).toEqual([]);
  });

  it("denies a cross-principal target hint without fan-down", async () => {
    const harness = await startHarness();
    const raw = await connectRawAgent({ port: harness.edge.agentPort, token: harness.token });
    const clientA = await issuer.signToken({ clientId: "client-a" });

    const crossed = await modernCall(harness.edge.northboundUrl, clientA, {
      args: { site: "tenant-beta" },
    });
    expect(crossed.status).toBe(403);
    expect(JSON.parse(crossed.body)).toEqual({ error: "not_entitled" });

    const conflicting = await modernCall(harness.edge.northboundUrl, clientA, {
      args: { site: "tenant-alpha", target: "tenant-beta" },
    });
    expect(conflicting.status).toBe(403);

    await settle();
    expect(raw.frames.filter((frame) => frame.type === "mcp-request")).toEqual([]);

    const granted = await modernCall(harness.edge.northboundUrl, clientA, {
      args: { site: "tenant-alpha" },
    });
    expect(granted.status).toBe(200);
    await settle();
    expect(raw.frames.filter((frame) => frame.type === "mcp-request")).toHaveLength(1);
  });
});

describe("agent channel", () => {
  it("denies a rogue agent and answers an entitled caller 503 no_agent without tenant detail", async () => {
    const harness = await startHarness();
    const rogue = await connectRawAgent({
      port: harness.edge.agentPort,
      token: `channel-${"0".repeat(48)}`,
    });
    expect(rogue.denied).toBe("unauthenticated");
    expect(harness.edge.hasAgent).toBe(false);

    const entitled = await issuer.signToken({ clientId: "client-a" });
    const res = await modernCall(harness.edge.northboundUrl, entitled, {
      args: { site: "tenant-alpha" },
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "no_agent" });
  });

  it("denies a revoked channel credential at hello", async () => {
    const harness = await startHarness();
    harness.channel.write({
      "tenant-a": { tokenSha256: sha256hex(harness.token), revoked: true },
    });
    const revoked = await connectRawAgent({ port: harness.edge.agentPort, token: harness.token });
    expect(revoked.denied).toBe("revoked");
    expect(harness.edge.hasAgent).toBe(false);
  });

  it("bounds channel revocation per request: in-flight finishes, the next request is denied", async () => {
    const harness = await startHarness();
    const { tenant } = await startRealAgent(harness);
    const jwt = await issuer.signToken({ clientId: "client-a" });
    const traffic = [];
    const client = await connectModernClient(harness.edge.northboundUrl, jwt, traffic);

    const hold = tenant.armHold();
    const inFlight = client.callTool({
      name: "drupal_relay_echo",
      arguments: { hold: true, site: "tenant-alpha" },
    });
    await hold.started;

    harness.channel.write({
      "tenant-a": { tokenSha256: sha256hex(harness.token), revoked: true },
    });
    hold.release();
    const finished = echoPayload(await inFlight);
    expect(finished.tenant).toBe(true);
    expect(tenant.calls).toHaveLength(1);

    const next = await modernCall(harness.edge.northboundUrl, jwt, {
      args: { site: "tenant-alpha" },
    });
    expect(next.status).toBe(403);
    expect(JSON.parse(next.body)).toEqual({
      error: "revoked",
      bound: EDGE_REVOCATION_BOUND.name,
    });
    expect(tenant.calls).toHaveLength(1);
  });

  it("reconnects after a drop with the same channel identity", async () => {
    const harness = await startHarness();
    const { agent } = await startRealAgent(harness);
    expect(harness.edge.agentId).toBe("tenant-a");

    agent.drop();
    await expect.poll(() => harness.edge.hasAgent).toBe(false);

    const hello = await agent.dial();
    expect(hello.ok).toBe(true);
    expect(hello.agent).toEqual({ agentId: "tenant-a" });
    expect(harness.edge.agentId).toBe("tenant-a");
  });
});

describe("stateless MCP 2026-07-28 end to end", () => {
  it("serves the real connector factory through edge and agent with no session ids", async () => {
    const harness = await startHarness();
    const { tenant } = await startRealAgent(harness);
    const jwt = await issuer.signToken({ clientId: "client-a" });
    const traffic = [];
    const client = await connectModernClient(harness.edge.northboundUrl, jwt, traffic);

    expect(client.getNegotiatedProtocolVersion()).toBe(EDGE_MCP_PROTOCOL);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["drupal_relay_echo"]);

    const echoed = echoPayload(await client.callTool({
      name: "drupal_relay_echo",
      arguments: { site: "tenant-alpha" },
    }));
    expect(echoed.tenant).toBe(true);
    expect(echoed.identity).toMatchObject({
      sub: "northbound-agent",
      clientId: "client-a",
      scopes: ["mcp_read"],
    });
    expect(tenant.calls[0].identity).toMatchObject({ clientId: "client-a" });

    expect(traffic.every((row) => row.headers["mcp-session-id"] === undefined)).toBe(true);
    expect(traffic.every((row) => row.responseHeaders["mcp-session-id"] === undefined)).toBe(true);
    expect(String(harness.edge.northboundUrl)).not.toMatch(/wilkesliberty\.com/i);
    expect(harness.token).not.toBe(process.env.MCP_AUTH_TOKEN);
  });

  it("refuses sessionful northbound traffic in both shapes", async () => {
    const harness = await startHarness();
    await startRealAgent(harness);
    const jwt = await issuer.signToken({ clientId: "client-a" });

    const get = await fetch(new URL("/mcp", harness.edge.northboundUrl), {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(get.status).toBe(400);

    const sessionful = await modernCall(harness.edge.northboundUrl, jwt, {
      args: { site: "tenant-alpha" },
      headers: { "mcp-session-id": "stale-session-1" },
    });
    expect(sessionful.status).toBe(400);
  });
});

describe("token never crosses the tunnel", () => {
  it("proves the capture can detect a token, then shows credentials never cross", async () => {
    const harness = await startHarness();
    const raw = await connectRawAgent({ port: harness.edge.agentPort, token: harness.token });
    const jwt = await issuer.signToken({ clientId: "client-a" });

    // Poison control: a non-credential header carrying the token DOES cross,
    // so the capture is proven able to see a leak before we trust its silence.
    const poisoned = await modernCall(harness.edge.northboundUrl, jwt, {
      args: { site: "tenant-alpha" },
      headers: { "x-relay-probe": jwt },
    });
    expect(poisoned.status).toBe(200);
    await settle();
    const poisonFrames = raw.frames.filter((frame) => frame.type === "mcp-request");
    expect(poisonFrames).toHaveLength(1);
    expect(JSON.stringify(poisonFrames[0])).toContain(jwt);

    // Clean run: credential and identity-assertion headers are stripped; the
    // frame carries the validated identity object only.
    const clean = await modernCall(harness.edge.northboundUrl, jwt, {
      args: { site: "tenant-alpha" },
      headers: {
        cookie: `session=${jwt}`,
        "proxy-authorization": `Bearer ${jwt}`,
        "x-mcp-subject": "spoofed-admin",
      },
    });
    expect(clean.status).toBe(200);
    await settle();
    const frames = raw.frames.filter((frame) => frame.type === "mcp-request");
    expect(frames).toHaveLength(2);
    const cleanFrame = frames[1];
    expect(JSON.stringify(cleanFrame)).not.toContain(jwt);
    const headerNames = Object.keys(cleanFrame.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("authorization");
    expect(headerNames).not.toContain("cookie");
    expect(headerNames).not.toContain("proxy-authorization");
    expect(headerNames).not.toContain("x-mcp-subject");
    expect(cleanFrame.identity).toMatchObject({ sub: "northbound-agent", clientId: "client-a" });
  });
});

describe("outbound-only and tenant-side southbound egress", () => {
  it("shows the agent dialed, the edge never dialed out, and site credentials stayed tenant-side", async () => {
    const stub = track(await startRecordingStub());
    const harness = await startHarness();
    const { tenant } = await startRealAgent(harness, { stub });
    const jwt = await issuer.signToken({ clientId: "client-a" });
    const traffic = [];
    const client = await connectModernClient(harness.edge.northboundUrl, jwt, traffic);

    const echoed = echoPayload(await client.callTool({
      name: "drupal_relay_echo",
      arguments: { site: "tenant-alpha" },
    }));
    expect(echoed.southbound).toBe(200);

    // Ledger: the agent dialed the edge; nothing dialed the agent; every
    // listener is a loopback edge listener.
    expect(harness.ledger.connects).toEqual([
      { role: "agent", host: "127.0.0.1", port: harness.edge.agentPort },
    ]);
    expect(harness.ledger.connects.filter((row) => row.role === "edge")).toEqual([]);
    expect(harness.ledger.listens.map((row) => row.role).sort()).toEqual([
      "edge-agent-channel",
      "edge-northbound",
    ]);
    expect(harness.ledger.listens.every((row) => row.host === "127.0.0.1")).toBe(true);

    // Southbound egress originated tenant-side with the tenant-held site
    // credential; the northbound token never reached the recording stub.
    expect(stub.hits).toHaveLength(1);
    expect(stub.hits[0].headers.authorization).toBe(`Bearer ${tenant.siteCredential}`);
    expect(JSON.stringify(stub.hits)).not.toContain(jwt);

    // The edge held no site credential to leak: its catalog is names only.
    expect(SITES.every((site) => Object.keys(site).every((key) => key === "_name"))).toBe(true);
  });
});

describe("agent refuses an identity-less request frame", () => {
  it("fails closed instead of dispatching as the local operator", async () => {
    // A hostile or buggy edge that omits the validated identity must not get
    // a dispatch: a null principal downstream means "local operator". Stand
    // up a fake edge speaking the channel protocol and send an mcp-request
    // with no identity.
    const { createServer } = await import("node:net");
    const received = [];
    let helloSeen = null;
    const fakeEdge = createServer((socket) => {
      attachFramer(socket, (frame) => {
        if (frame.type === "hello") {
          helloSeen = frame;
          writeFrame(socket, { type: "hello-ok", agent: { agentId: "tenant-a" } });
          writeFrame(socket, {
            type: "mcp-request",
            id: "no-identity-1",
            method: "POST",
            url: "/mcp",
            headers: { "content-type": "application/json" },
            body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
          });
          return;
        }
        received.push(frame);
      });
    });
    await new Promise((resolve) => fakeEdge.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => fakeEdge.close(resolve)));

    const tenant = tenantSurface();
    const agent = createRelayAgent({
      host: "127.0.0.1",
      port: fakeEdge.address().port,
      token: "channel-fake-edge-test",
      surface: tenant.surface,
    });
    closers.push(() => agent.close());
    const hello = await agent.dial();
    expect(hello.ok).toBe(true);
    expect(helloSeen.token).toBe("channel-fake-edge-test");

    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toMatchObject({
      type: "mcp-response",
      id: "no-identity-1",
      status: 403,
    });
    expect(JSON.parse(received[0].body)).toEqual({ error: "missing_identity" });
    expect(tenant.calls).toEqual([]);
  });

  it("reports a lost channel through onChannelClose so the entry point can fail loudly", async () => {
    const harness = await startHarness();
    const tenant = tenantSurface();
    let closed = 0;
    const agent = createRelayAgent({
      host: "127.0.0.1",
      port: harness.edge.agentPort,
      token: harness.token,
      surface: tenant.surface,
      onChannelClose: () => { closed += 1; },
    });
    closers.push(() => agent.close());
    const hello = await agent.dial();
    expect(hello.ok).toBe(true);

    await harness.edge.close();
    await expect.poll(() => closed).toBe(1);
  });
});

describe("tenant isolation (#242 / DEV-122)", () => {
  it("keeps two scoped agents connected and fans each principal only to its tenant", async () => {
    const harness = await startTwoTenantHarness();
    const { tenant: tenantA } = await startRealAgent(harness, {
      token: harness.tokenA,
      siteCredential: "secret-alpha-only",
    });
    const { tenant: tenantB } = await startRealAgent(harness, {
      token: harness.tokenB,
      siteCredential: "secret-beta-only",
    });
    expect(harness.edge.hasAgent).toBe(true);
    expect(harness.edge.agentId).toBeNull();
    expect([...harness.edge.agentIds].sort()).toEqual(["tenant-a", "tenant-b"]);

    const jwtA = await issuer.signToken({ clientId: "client-a" });
    const jwtB = await issuer.signToken({ clientId: "client-b" });
    const clientA = await connectModernClient(harness.edge.northboundUrl, jwtA, []);
    const clientB = await connectModernClient(harness.edge.northboundUrl, jwtB, []);

    const echoedA = echoPayload(await clientA.callTool({
      name: "drupal_relay_echo",
      arguments: { site: "tenant-alpha" },
    }));
    const echoedB = echoPayload(await clientB.callTool({
      name: "drupal_relay_echo",
      arguments: { site: "tenant-beta" },
    }));
    expect(echoedA.identity.clientId).toBe("client-a");
    expect(echoedB.identity.clientId).toBe("client-b");
    expect(tenantA.calls).toHaveLength(1);
    expect(tenantB.calls).toHaveLength(1);
    expect(tenantA.calls[0].identity.clientId).toBe("client-a");
    expect(tenantB.calls[0].identity.clientId).toBe("client-b");
  });

  it("denies cross-tenant hints and discovery with zero frames on the other tunnel", async () => {
    const harness = await startTwoTenantHarness();
    const rawA = await connectRawAgent({ port: harness.edge.agentPort, token: harness.tokenA });
    const rawB = await connectRawAgent({ port: harness.edge.agentPort, token: harness.tokenB });
    const jwtA = await issuer.signToken({ clientId: "client-a" });

    const crossed = await modernCall(harness.edge.northboundUrl, jwtA, {
      args: { site: "tenant-beta" },
    });
    expect(crossed.status).toBe(403);
    expect(JSON.parse(crossed.body)).toEqual({ error: "not_entitled" });

    const listed = await modernCall(harness.edge.northboundUrl, jwtA, { method: "tools/list" });
    expect(listed.status).toBe(200);
    await settle();
    expect(rawA.frames.filter((frame) => frame.type === "mcp-request")).toHaveLength(1);
    expect(rawB.frames.filter((frame) => frame.type === "mcp-request")).toEqual([]);
  });

  it("keeps each tenant's site credential inside its own process", async () => {
    const stubA = track(await startRecordingStub());
    const stubB = track(await startRecordingStub());
    const harness = await startTwoTenantHarness();
    const { tenant: tenantA } = await startRealAgent(harness, {
      token: harness.tokenA,
      stub: stubA,
      siteCredential: "secret-alpha-only",
    });
    await startRealAgent(harness, {
      token: harness.tokenB,
      stub: stubB,
      siteCredential: "secret-beta-only",
    });
    const jwtA = await issuer.signToken({ clientId: "client-a" });
    const jwtB = await issuer.signToken({ clientId: "client-b" });
    const clientA = await connectModernClient(harness.edge.northboundUrl, jwtA, []);
    const clientB = await connectModernClient(harness.edge.northboundUrl, jwtB, []);

    await clientA.callTool({ name: "drupal_relay_echo", arguments: { site: "tenant-alpha" } });
    await clientB.callTool({ name: "drupal_relay_echo", arguments: { site: "tenant-beta" } });

    expect(stubA.hits).toHaveLength(1);
    expect(stubB.hits).toHaveLength(1);
    expect(stubA.hits[0].headers.authorization).toBe(`Bearer ${tenantA.siteCredential}`);
    expect(stubB.hits[0].headers.authorization).toBe("Bearer secret-beta-only");
    expect(JSON.stringify(stubA.hits)).not.toContain("secret-beta-only");
    expect(JSON.stringify(stubB.hits)).not.toContain("secret-alpha-only");
    expect(JSON.stringify(stubA.hits)).not.toContain(jwtA);
    expect(JSON.stringify(stubB.hits)).not.toContain(jwtB);
  });

  it("denies a second unscoped agent and an overlapping site bind at hello", async () => {
    const unscoped = await startHarness();
    const scopedJoin = await connectRawAgent({
      port: unscoped.edge.agentPort,
      token: `channel-${"1".repeat(48)}`,
    });
    expect(scopedJoin.denied).toBe("unauthenticated");

    const overlap = createChannelFile();
    const tokenA = `channel-a-${randomBytes(24).toString("hex")}`;
    const tokenB = `channel-b-${randomBytes(24).toString("hex")}`;
    overlap.write({
      "tenant-a": { tokenSha256: sha256hex(tokenA), sites: ["tenant-alpha"] },
      "tenant-b": { tokenSha256: sha256hex(tokenB), sites: ["tenant-alpha"] },
    });
    const edge = await startEdge(baseEdgeOptions({
      channelCredentials: createChannelCredentialStore({ filePath: overlap.filePath }),
    }));
    closers.push(() => edge.close());
    const first = await connectRawAgent({ port: edge.agentPort, token: tokenA });
    expect(first.denied).toBeNull();
    const second = await connectRawAgent({ port: edge.agentPort, token: tokenB });
    expect(second.denied).toBe("overlapping_tenant");
    expect(edge.agentIds).toEqual(["tenant-a"]);

    const mixed = createChannelFile();
    const unscopedToken = `channel-u-${randomBytes(24).toString("hex")}`;
    const scopedToken = `channel-s-${randomBytes(24).toString("hex")}`;
    mixed.write({
      "tenant-a": { tokenSha256: sha256hex(unscopedToken) },
      "tenant-b": { tokenSha256: sha256hex(scopedToken), sites: ["tenant-beta"] },
    });
    const mixedEdge = await startEdge(baseEdgeOptions({
      channelCredentials: createChannelCredentialStore({ filePath: mixed.filePath }),
    }));
    closers.push(() => mixedEdge.close());
    const sole = await connectRawAgent({ port: mixedEdge.agentPort, token: unscopedToken });
    expect(sole.denied).toBeNull();
    const extra = await connectRawAgent({ port: mixedEdge.agentPort, token: scopedToken });
    expect(extra.denied).toBe("unbound_tenant");
  });

  it("does not fail tenant A when tenant B disconnects, in-flight or next request", async () => {
    const harness = await startTwoTenantHarness();
    const { tenant: tenantA } = await startRealAgent(harness, { token: harness.tokenA });
    const { agent: agentB } = await startRealAgent(harness, { token: harness.tokenB });
    const jwtA = await issuer.signToken({ clientId: "client-a" });
    const jwtB = await issuer.signToken({ clientId: "client-b" });
    const clientA = await connectModernClient(harness.edge.northboundUrl, jwtA, []);

    const hold = tenantA.armHold();
    const inFlight = clientA.callTool({
      name: "drupal_relay_echo",
      arguments: { hold: true, site: "tenant-alpha" },
    });
    await hold.started;
    agentB.drop();
    await expect.poll(() => harness.edge.agentIds).toEqual(["tenant-a"]);
    hold.release();
    const finished = echoPayload(await inFlight);
    expect(finished.tenant).toBe(true);

    const next = echoPayload(await clientA.callTool({
      name: "drupal_relay_echo",
      arguments: { site: "tenant-alpha" },
    }));
    expect(next.tenant).toBe(true);

    const bGone = await modernCall(harness.edge.northboundUrl, jwtB, {
      args: { site: "tenant-beta" },
    });
    expect(bGone.status).toBe(503);
    expect(JSON.parse(bGone.body)).toEqual({ error: "no_agent" });
  });

  it("ignores a cross-tenant mcp-response injection and still completes from the owner", async () => {
    const harness = await startTwoTenantHarness();
    const rawA = await connectRawAgent({
      port: harness.edge.agentPort,
      token: harness.tokenA,
      autoReply: false,
    });
    const rawB = await connectRawAgent({
      port: harness.edge.agentPort,
      token: harness.tokenB,
      autoReply: false,
    });
    const jwtA = await issuer.signToken({ clientId: "client-a" });
    const pending = modernCall(harness.edge.northboundUrl, jwtA, {
      args: { site: "tenant-alpha" },
    });
    await expect.poll(
      () => rawA.frames.filter((frame) => frame.type === "mcp-request").length,
    ).toBe(1);
    const request = rawA.frames.find((frame) => frame.type === "mcp-request");
    expect(request.correlation).toEqual({
      requestId: request.id,
      tenant: "tenant-a",
    });
    expect(JSON.stringify(request)).not.toContain(harness.tokenA);
    expect(JSON.stringify(request)).not.toContain(harness.tokenB);
    expect(JSON.stringify(request)).not.toContain(jwtA);

    writeFrame(rawB.socket, {
      type: "mcp-response",
      id: request.id,
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ injected: true }),
    });
    await settle();
    writeFrame(rawA.socket, {
      type: "mcp-response",
      id: request.id,
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, result: { from: "tenant-a" } }),
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toContain("tenant-a");
    expect(res.body).not.toContain("injected");
    expect(rawB.frames.filter((frame) => frame.type === "mcp-request")).toEqual([]);
  });

  it("destroys a socket that sends mcp-response before hello", async () => {
    const harness = await startTwoTenantHarness();
    const { tenant } = await startRealAgent(harness, { token: harness.tokenA });
    const jwtA = await issuer.signToken({ clientId: "client-a" });
    const hold = tenant.armHold();
    const client = await connectModernClient(harness.edge.northboundUrl, jwtA, []);
    const inFlight = client.callTool({
      name: "drupal_relay_echo",
      arguments: { hold: true, site: "tenant-alpha" },
    });
    await hold.started;

    const rogue = netConnect({ host: "127.0.0.1", port: harness.edge.agentPort });
    closers.push(() => { rogue.destroy(); });
    await new Promise((resolve, reject) => {
      rogue.once("connect", resolve);
      rogue.once("error", reject);
    });
    writeFrame(rogue, {
      type: "mcp-response",
      id: "guessed-id",
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ injected: true }),
    });
    await expect.poll(() => rogue.destroyed || rogue.readableEnded).toBeTruthy();

    hold.release();
    const finished = echoPayload(await inFlight);
    expect(finished.tenant).toBe(true);
    expect(finished).not.toHaveProperty("injected");
  });

  it("reconnects one tenant without dropping the other", async () => {
    const harness = await startTwoTenantHarness();
    const { agent: agentA } = await startRealAgent(harness, { token: harness.tokenA });
    await startRealAgent(harness, { token: harness.tokenB });
    expect([...harness.edge.agentIds].sort()).toEqual(["tenant-a", "tenant-b"]);

    agentA.drop();
    await expect.poll(() => [...harness.edge.agentIds]).toEqual(["tenant-b"]);

    const hello = await agentA.dial();
    expect(hello.ok).toBe(true);
    expect(hello.agent).toEqual({ agentId: "tenant-a" });
    expect([...harness.edge.agentIds].sort()).toEqual(["tenant-a", "tenant-b"]);
  });
});
