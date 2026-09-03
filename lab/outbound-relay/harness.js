/**
 * Laboratory outbound-relay harness.
 *
 * Isolated lab proof of Model B: a tenant agent dials out to a loopback
 * relay; the relay never opens a connection to the agent; a stub private
 * Drupal never listens. Not a public surface, not a hosted-service claim,
 * and not the product edge (#232). Vendor tunnels stay outside `createLocalRelay` (#181).
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createLocalRelay } from "../../src/lib/contracts/relay.js";
import { createConnectorServerFactory } from "../../src/lib/mcp-server.js";

/** Next northbound request after revoke is denied. No grace window. */
export const LAB_REVOCATION_BOUND = Object.freeze({
  name: "per-request",
  graceMs: 0,
  description:
    "Revocation is checked at the start of each northbound request. "
    + "The next request after revoke is denied. An in-flight request may finish.",
});

export const LAB_MCP_PROTOCOL = "2026-07-28";

export const LAB_IDENTITY = Object.freeze({
  sub: "lab-tenant-agent",
  clientId: "lab-tenant-agent",
  tenant: "lab-tenant",
  scopes: Object.freeze(["mcp_read"]),
});

/** Catalog site for #181 target resolution. Not a reachable inbound Drupal. */
export const LAB_SITE = Object.freeze({
  _name: "lab-private-drupal",
  baseUrl: "http://private.lab.invalid/drupal",
  security: Object.freeze({ preset: "development" }),
});

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

/**
 * Caller credential headers. The northbound caller's credentials authenticate
 * the caller to the edge; they must never cross the tunnel toward the tenant
 * (#229). The tenant side receives the bound identity object, not headers.
 */
const CALLER_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const FAN_DOWN_TIMEOUT_MS = 10_000;

/**
 * Record listen/connect attempts so tests can fail if Drupal opened inbound
 * or the relay dialed the agent.
 *
 * @returns {{listens: object[], connects: object[], recordListen: Function, recordConnect: Function}}
 */
export function createConnectionLedger() {
  const listens = [];
  const connects = [];
  return {
    listens,
    connects,
    /**
     * @param {string} role
     * @param {{host?: string, port?: number}} address
     */
    recordListen(role, address) {
      listens.push({ role, host: address.host, port: address.port });
    },
    /**
     * @param {string} role
     * @param {{host?: string, port?: number}} address
     */
    recordConnect(role, address) {
      connects.push({ role, host: address.host, port: address.port });
    },
  };
}

/**
 * Local, revocable lab credentials. Not `MCP_AUTH_TOKEN`.
 *
 * @returns {{issue: Function, lookup: Function, revoke: Function}}
 */
export function createLabCredentialRegistry() {
  const issued = [];

  return {
    /**
     * @param {{identity: object}} params
     * @returns {string}
     */
    issue({ identity }) {
      const token = `lab-${randomBytes(24).toString("hex")}`;
      issued.push({ token, identity: Object.freeze({ ...identity }), revoked: false });
      return token;
    },

    /**
     * @param {string} token
     * @returns {{token: string, identity: object, revoked: boolean}|null}
     */
    lookup(token) {
      if (typeof token !== "string" || !token.startsWith("lab-")) return null;
      const found = issued.find((entry) => safeEqual(entry.token, token));
      return found ? { token: found.token, identity: found.identity, revoked: found.revoked } : null;
    },

    /**
     * @param {object} identity
     */
    revoke(identity) {
      for (const entry of issued) {
        if (sameIdentity(entry.identity, identity)) entry.revoked = true;
      }
    },
  };
}

/**
 * In-process stub Drupal MCP (2026-07-28, stateless). Never listens.
 *
 * @param {object} [params]
 * @param {object} [params.site]
 * @param {object} [params.ledger]
 * @returns {object}
 */
export function createStubDrupal({ site = LAB_SITE, ledger = createConnectionLedger() } = {}) {
  let hits = 0;
  let hold = null;
  let boundIdentity = null;
  let boundTarget = null;
  const listenAddress = null;

  const surface = {
    serverInfo: { name: "lab-stub-drupal", version: "0.0.0-lab" },
    tools: {
      definitions: [{
        name: "drupal_lab_echo",
        description: "Lab-only stub marker. Not a published connector tool.",
        inputSchema: {
          type: "object",
          properties: {
            hold: { type: "boolean" },
          },
        },
      }],
      call: async (_name, args = {}) => {
        hits += 1;
        if (args.hold && hold) {
          hold.startedResolve();
          await hold.waiting;
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              stub: "private-drupal",
              inboundDrupalPort: listenAddress,
              identity: boundIdentity,
              target: boundTarget,
              site: site._name,
              hits,
            }),
          }],
        };
      },
    },
    resources: {
      definitions: [],
      read: async (uri) => ({ uri, lab: true }),
    },
    prompts: {
      definitions: [],
      get: () => [],
    },
  };

  const handler = createMcpHandler(createConnectorServerFactory(surface), { legacy: "reject" });

  return {
    site,
    mode: "in-process",
    listenAddress,
    ledger,
    get hits() { return hits; },
    /**
     * Bind the tunnel identity after a successful outbound hello.
     * @param {object} identity
     * @param {{name: string, source: string}|null} target
     */
    bindTunnel(identity, target) {
      boundIdentity = identity;
      boundTarget = target;
    },
    /**
     * Arm a one-shot hold so an in-flight tools/call can outlive revoke.
     * @returns {{started: Promise<void>, release: () => void}}
     */
    armHold() {
      let startedResolve = () => {};
      let release = () => {};
      const started = new Promise((resolve) => { startedResolve = resolve; });
      const waiting = new Promise((resolve) => { release = resolve; });
      hold = { started, waiting, startedResolve, release };
      return { started, release };
    },
    /**
     * Apply one MCP HTTP request to the stub without opening a port.
     * @param {{method?: string, url?: string, headers?: object, body?: string|object}} frame
     * @returns {Promise<{status: number, headers: object, body: string}>}
     */
    async handleMcp(frame) {
      const headers = forwardHeaders(frame.headers);
      const body = encodeBody(frame.body);
      const request = new Request("http://127.0.0.1/mcp", {
        method: frame.method || "POST",
        headers,
        ...(body != null ? { body } : {}),
      });
      const response = await handler.fetch(request);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
    },
    /**
     * @returns {Promise<void>}
     */
    async close() {
      await handler.close();
    },
  };
}

/**
 * Loopback relay: accepts an outbound agent TCP channel and proxies
 * northbound Streamable-HTTP `/mcp` down that channel.
 *
 * @param {object} params
 * @param {ReturnType<typeof createLabCredentialRegistry>} params.credentials
 * @param {{resolve: Function}} params.targetRelay
 * @param {ReturnType<typeof createConnectionLedger>} [params.ledger]
 * @returns {Promise<object>}
 */
export async function createLabRelay({
  credentials,
  targetRelay,
  ledger = createConnectionLedger(),
} = {}) {
  let session = null;
  const pending = new Map();
  let lastResolved = null;

  const agentServer = createNetServer((socket) => {
    attachFramer(socket, (frame) => {
      if (frame.type === "hello") {
        const record = credentials.lookup(frame.token);
        if (!record) {
          writeFrame(socket, { type: "denied", reason: "unauthenticated" });
          socket.end();
          return;
        }
        if (record.revoked) {
          writeFrame(socket, { type: "denied", reason: "revoked" });
          socket.end();
          return;
        }
        const resolved = targetRelay.resolve(record.identity);
        lastResolved = { name: resolved.name, source: resolved.source };
        if (session && session.socket !== socket) {
          session.socket.destroy();
        }
        session = { socket, identity: record.identity, token: record.token, target: lastResolved };
        writeFrame(socket, {
          type: "hello-ok",
          identity: record.identity,
          target: lastResolved,
        });
        return;
      }
      if (frame.type === "mcp-response" && typeof frame.id === "string") {
        const waiter = pending.get(frame.id);
        if (waiter) {
          pending.delete(frame.id);
          waiter.resolve(frame);
        }
      }
    });
    socket.on("close", () => {
      if (session && session.socket === socket) session = null;
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(new Error("lab agent channel closed"));
      }
    });
  });

  const northbound = createHttpServer((req, res) => {
    void handleNorthbound(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502).end("lab fan-down failed");
    });
  });

  async function handleNorthbound(req, res) {
    const path = String(req.url || "").split("?")[0];
    if (req.method !== "POST" || path !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }

    const body = await readHttpBody(req);
    const record = session ? credentials.lookup(session.token) : null;
    if (record?.revoked) {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({
        error: "revoked",
        bound: LAB_REVOCATION_BOUND.name,
      }));
      return;
    }
    if (!session || !record) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({
        error: "no_agent",
        lab: true,
      }));
      return;
    }

    const resolved = targetRelay.resolve(session.identity);
    lastResolved = { name: resolved.name, source: resolved.source };

    const id = randomUUID();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("lab fan-down timeout"));
      }, FAN_DOWN_TIMEOUT_MS);
      pending.set(id, {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      writeFrame(session.socket, {
        type: "mcp-request",
        id,
        method: req.method,
        url: path,
        headers: fanDownHeaders(req.headers),
        body,
      });
    });

    const headers = forwardHeaders(result.headers);
    res.writeHead(result.status || 200, headers);
    res.end(result.body ?? "");
  }

  const agentAddr = await listenLoopback(agentServer, "relay-agent", ledger);
  const httpAddr = await listenLoopback(northbound, "relay-northbound", ledger);

  return {
    ledger,
    get lastResolved() { return lastResolved; },
    get sessionIdentity() { return session?.identity ?? null; },
    get hasAgent() { return Boolean(session); },
    agentPort: agentAddr.port,
    northboundUrl: new URL(`http://127.0.0.1:${httpAddr.port}/mcp`),
    /**
     * @returns {Promise<void>}
     */
    async close() {
      session?.socket.destroy();
      session = null;
      await closeServer(agentServer);
      await closeServer(northbound);
    },
  };
}

/**
 * Tenant agent: dials the relay, then forwards MCP frames to the in-process stub.
 *
 * @param {object} params
 * @param {string} params.host
 * @param {number} params.port
 * @param {string} params.token
 * @param {object} params.stub
 * @param {ReturnType<typeof createConnectionLedger>} [params.ledger]
 * @returns {object}
 */
export function createTenantAgent({ host, port, token, stub, ledger = createConnectionLedger() }) {
  let socket = null;
  let bound = null;

  async function onFrame(frame) {
    if (frame.type !== "mcp-request") return;
    const response = await stub.handleMcp(frame);
    if (socket) {
      writeFrame(socket, { type: "mcp-response", id: frame.id, ...response });
    }
  }

  return {
    /**
     * Dial out to the relay. The relay never connects here.
     * @returns {Promise<{ok: boolean, reason?: string, identity?: object, target?: object}>}
     */
    dial() {
      return new Promise((resolve, reject) => {
        ledger.recordConnect("agent", { host, port });
        const next = netConnect({ host, port }, () => {
          writeFrame(next, { type: "hello", token });
        });
        socket = next;
        attachFramer(next, (frame) => {
          if (frame.type === "hello-ok") {
            bound = { identity: frame.identity, target: frame.target };
            stub.bindTunnel(frame.identity, frame.target);
            resolve({ ok: true, identity: frame.identity, target: frame.target });
            return;
          }
          if (frame.type === "denied") {
            next.end();
            resolve({ ok: false, reason: frame.reason });
            return;
          }
          void onFrame(frame);
        });
        next.on("error", reject);
      });
    },
    /**
     * Drop the outbound channel without destroying the agent.
     */
    drop() {
      socket?.destroy();
      socket = null;
    },
    get bound() { return bound; },
    /**
     * @returns {void}
     */
    close() {
      this.drop();
    },
  };
}

/**
 * Start the smallest lab topology: loopback relay + outbound agent + stub Drupal.
 *
 * @param {object} [options]
 * @param {boolean} [options.autoDial=true]
 * @returns {Promise<object>}
 */
export async function startLabHarness(options = {}) {
  const identity = options.identity ?? LAB_IDENTITY;
  const site = options.site ?? LAB_SITE;
  const ledger = options.ledger ?? createConnectionLedger();
  const credentials = createLabCredentialRegistry();
  const token = credentials.issue({ identity });
  const targetRelay = createLocalRelay({
    sites: [site],
    grants: { [identity.clientId]: [site._name] },
    defaultSite: site._name,
  });
  const stub = createStubDrupal({ site, ledger });
  const relay = await createLabRelay({ credentials, targetRelay, ledger });
  const agent = createTenantAgent({
    host: "127.0.0.1",
    port: relay.agentPort,
    token,
    stub,
    ledger,
  });

  if (options.autoDial !== false) {
    const hello = await agent.dial();
    if (!hello.ok) {
      await stub.close();
      await relay.close();
      throw new Error(`lab agent hello failed: ${hello.reason}`);
    }
  }

  return {
    credentials,
    token,
    identity,
    site,
    stub,
    relay,
    agent,
    ledger,
    targetRelay,
    northboundUrl: relay.northboundUrl,
    /**
     * @returns {Promise<void>}
     */
    async close() {
      agent.close();
      await relay.close();
      await stub.close();
    },
  };
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
function sameIdentity(left, right) {
  return left?.sub === right?.sub
    && left?.clientId === right?.clientId
    && left?.tenant === right?.tenant;
}

/**
 * @param {import("node:net").Socket} socket
 * @param {(frame: object) => void} onFrame
 */
function attachFramer(socket, onFrame) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32BE(0);
      if (size > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      if (buffer.length < 4 + size) break;
      const json = buffer.subarray(4, 4 + size).toString("utf8");
      buffer = buffer.subarray(4 + size);
      onFrame(JSON.parse(json));
    }
  });
}

/**
 * @param {import("node:net").Socket} socket
 * @param {object} object
 */
function writeFrame(socket, object) {
  if (!socket.writable) return;
  const payload = Buffer.from(JSON.stringify(object), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

/**
 * @param {object} [headers]
 * @returns {Record<string, string>}
 */
function forwardHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(String(name).toLowerCase())) continue;
    if (value == null) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/**
 * Headers a northbound request may carry down the tunnel: hop-by-hop and
 * caller credential headers are stripped before framing (#229).
 * @param {Record<string, string|string[]>} [headers]
 * @returns {Record<string, string>}
 */
function fanDownHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(forwardHeaders(headers))) {
    if (CALLER_CREDENTIAL_HEADERS.has(String(name).toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/**
 * @param {string|object|undefined} body
 * @returns {string|undefined}
 */
function encodeBody(body) {
  if (body == null || body === "") return undefined;
  return typeof body === "string" ? body : JSON.stringify(body);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<string>}
 */
async function readHttpBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {import("node:net").Server} server
 * @param {string} role
 * @param {ReturnType<typeof createConnectionLedger>} ledger
 * @returns {Promise<{host: string, port: number}>}
 */
function listenLoopback(server, role, ledger) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const recorded = { host: address.address, port: address.port };
      ledger.recordListen(role, recorded);
      resolve(recorded);
    });
  });
}

/**
 * @param {import("node:net").Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
