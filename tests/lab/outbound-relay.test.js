import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  LAB_IDENTITY,
  LAB_MCP_PROTOCOL,
  LAB_REVOCATION_BOUND,
  LAB_SITE,
  createTenantAgent,
  startLabHarness,
} from "../../lab/outbound-relay/harness.js";

const closers = [];

afterEach(async () => {
  while (closers.length) await closers.pop()();
});

function track(lab) {
  closers.push(() => lab.close());
  return lab;
}

function northboundTransport(url, traffic) {
  return new StreamableHTTPClientTransport(url, {
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
}

async function connectModernClient(url, traffic) {
  const client = new Client(
    { name: "lab-northbound", version: "0.0.0-lab" },
    { capabilities: { roots: {} }, versionNegotiation: { mode: "auto" } }
  );
  closers.push(() => client.close());
  await client.connect(northboundTransport(url, traffic));
  return client;
}

function echoPayload(result) {
  const text = result.content.find((part) => part.type === "text")?.text;
  return JSON.parse(text);
}

describe("DEV-293 lab outbound relay", () => {
  it("carries one stateless MCP 2026-07-28 request to the stub through an outbound agent", async () => {
    const lab = track(await startLabHarness());
    const traffic = [];
    const client = await connectModernClient(lab.northboundUrl, traffic);

    expect(client.getNegotiatedProtocolVersion()).toBe(LAB_MCP_PROTOCOL);
    expect(lab.relay.sessionIdentity).toEqual(LAB_IDENTITY);
    expect(lab.relay.lastResolved).toEqual({ name: LAB_SITE._name, source: "default" });
    expect(lab.targetRelay.resolve(LAB_IDENTITY)).toMatchObject({
      name: LAB_SITE._name,
      source: "default",
    });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["drupal_lab_echo"]);
    const echoed = echoPayload(await client.callTool({ name: "drupal_lab_echo", arguments: {} }));

    expect(echoed).toMatchObject({
      stub: "private-drupal",
      inboundDrupalPort: null,
      site: "lab-private-drupal",
      identity: LAB_IDENTITY,
      target: { name: "lab-private-drupal", source: "default" },
    });
    expect(lab.stub.hits).toBe(1);
    expect(traffic.every((row) => row.headers["mcp-session-id"] === undefined)).toBe(true);
    expect(traffic.every((row) => row.responseHeaders["mcp-session-id"] === undefined)).toBe(true);
    expect(lab.northboundUrl.hostname).toBe("127.0.0.1");
    expect(lab.northboundUrl.href).not.toMatch(/wilkesliberty\.com/i);
    expect(lab.token.startsWith("lab-")).toBe(true);
    expect(lab.token).not.toBe(process.env.MCP_AUTH_TOKEN);
  });

  it("is outbound-only: agent dials the relay; Drupal never listens", async () => {
    const lab = track(await startLabHarness());
    const traffic = [];
    const client = await connectModernClient(lab.northboundUrl, traffic);
    await client.callTool({ name: "drupal_lab_echo", arguments: {} });

    expect(lab.stub.mode).toBe("in-process");
    expect(lab.stub.listenAddress).toBeNull();
    expect(lab.ledger.listens.filter((row) => row.role === "drupal")).toEqual([]);
    expect(lab.ledger.listens.filter((row) => row.role === "agent")).toEqual([]);
    expect(lab.ledger.connects.filter((row) => row.role === "relay")).toEqual([]);
    expect(lab.ledger.connects).toEqual([
      { role: "agent", host: "127.0.0.1", port: lab.relay.agentPort },
    ]);
    expect(lab.ledger.listens.every((row) => row.host === "127.0.0.1")).toBe(true);

    await expect(fetch(lab.site.baseUrl, { signal: AbortSignal.timeout(250) }))
      .rejects.toThrow();
  });

  it("rejects an unauthenticated agent and does not reach the stub", async () => {
    const lab = track(await startLabHarness({ autoDial: false }));
    const rogue = createTenantAgent({
      host: "127.0.0.1",
      port: lab.relay.agentPort,
      token: "lab-not-issued-000000000000000000000000000000000000000000000000",
      stub: lab.stub,
      ledger: lab.ledger,
    });

    const hello = await rogue.dial();
    expect(hello).toEqual({ ok: false, reason: "unauthenticated" });
    expect(lab.relay.hasAgent).toBe(false);
    expect(lab.stub.hits).toBe(0);

    const denied = await fetch(lab.northboundUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(denied.status).toBe(503);
    expect(await denied.json()).toMatchObject({ error: "no_agent" });
    expect(lab.stub.hits).toBe(0);
  });

  it("reconnects with the same identity after the channel is dropped", async () => {
    const lab = track(await startLabHarness());
    const firstTraffic = [];
    const first = await connectModernClient(lab.northboundUrl, firstTraffic);
    const before = echoPayload(await first.callTool({ name: "drupal_lab_echo", arguments: {} }));
    expect(before.identity).toEqual(LAB_IDENTITY);

    lab.agent.drop();
    await expect.poll(() => lab.relay.hasAgent).toBe(false);

    const hello = await lab.agent.dial();
    expect(hello.ok).toBe(true);
    expect(hello.identity).toEqual(LAB_IDENTITY);
    expect(hello.target).toEqual({ name: LAB_SITE._name, source: "default" });

    const secondTraffic = [];
    const second = await connectModernClient(lab.northboundUrl, secondTraffic);
    const after = echoPayload(await second.callTool({ name: "drupal_lab_echo", arguments: {} }));
    expect(after.identity).toEqual(before.identity);
    expect(after.target).toEqual(before.target);
    expect(lab.relay.sessionIdentity).toEqual(LAB_IDENTITY);
    expect(secondTraffic.every((row) => row.headers["mcp-session-id"] === undefined)).toBe(true);
  });

  it("denies the next request after revoke with no grace window", async () => {
    expect(LAB_REVOCATION_BOUND).toEqual({
      name: "per-request",
      graceMs: 0,
      description: expect.stringMatching(/next request after revoke is denied/i),
    });

    const lab = track(await startLabHarness());
    const traffic = [];
    const client = await connectModernClient(lab.northboundUrl, traffic);
    const hold = lab.stub.armHold();
    const inFlight = client.callTool({ name: "drupal_lab_echo", arguments: { hold: true } });
    await hold.started;

    lab.credentials.revoke(LAB_IDENTITY);
    hold.release();
    const finished = echoPayload(await inFlight);
    expect(finished.stub).toBe("private-drupal");
    expect(lab.stub.hits).toBe(1);

    const next = await fetch(lab.northboundUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": LAB_MCP_PROTOCOL,
        "Mcp-Method": "tools/call",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "drupal_lab_echo", arguments: {} },
      }),
    });
    expect(next.status).toBe(403);
    expect(await next.json()).toEqual({
      error: "revoked",
      bound: LAB_REVOCATION_BOUND.name,
    });
    expect(lab.stub.hits).toBe(1);
  });
});
