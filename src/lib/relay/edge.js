/**
 * Relay northbound edge (#232) — the DEV-294 AC4 slice.
 *
 * Terminates northbound MCP over the OAuth resource server and fans requests
 * down an outbound tenant-agent channel. The edge proposes; the tenant-side
 * connector disposes. Policy at this seam, fail-closed from birth:
 *
 *   - `createInboundHttpsAuth` is the ONLY authentication arm. There is no
 *     shared-bearer and no unauthenticated mode in this module; a missing
 *     issuer/audience is fatal at every bind host, loopback included.
 *   - A non-empty `auth.grants` table is mandatory. The library's all-sites
 *     fallback (principal.js) is untouched for existing installs; this entry
 *     point refuses to exist without explicit grants.
 *   - Caller credential headers (authorization, cookie, proxy-authorization —
 *     the #229 strip set) and caller identity-assertion headers are stripped
 *     before framing. The frame carries the validated identity object only.
 *   - The edge holds no site credentials: a catalog entry carrying credential
 *     material refuses startup. It cannot leak what it does not hold.
 *   - Stateless MCP 2026-07-28 northbound: sessionful traffic is refused and
 *     no `Mcp-Session-Id` crosses in either direction.
 *   - Revocation is per-request with no grace window, for both credential
 *     kinds (northbound principal, agent channel).
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { createLocalRelay } from "../contracts/relay.js";
import { createInboundHttpsAuth, SPOOFABLE_IDENTITY_HEADERS } from "../http-auth.js";
import { createLegacySessionHandler, createMcpRequestHandler } from "../http-handler.js";
import { resolveGrantedSites } from "../principal.js";
import {
  attachFramer,
  createRequestBroker,
  forwardHeaders,
  writeFrame,
} from "./frames.js";

/** Northbound protocol pin. Stateless; no session ids in either direction. */
export const EDGE_MCP_PROTOCOL = "2026-07-28";

/**
 * Revocation bound restated from the DEV-293 lab for both credential kinds.
 * The next request after revoke is denied; an in-flight request may finish.
 */
export const EDGE_REVOCATION_BOUND = Object.freeze({
  name: "per-request",
  graceMs: 0,
  appliesTo: Object.freeze(["northbound-principal", "agent-channel"]),
  description:
    "Revocation is checked at the start of each northbound request for the "
    + "principal token and the agent channel credential. The next request "
    + "after revoke is denied. An in-flight request may finish.",
});

/**
 * Caller credential headers (#229 parity). The northbound caller's
 * credentials authenticate the caller to the edge; they must never cross the
 * tunnel toward the tenant.
 */
export const CALLER_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

/** Site config keys that mean "this catalog entry carries a credential". */
const SITE_CREDENTIAL_KEYS = Object.freeze([
  "apiToken",
  "username",
  "password",
  "oauth",
  "basicAuth",
  "drushSsh",
]);

const DEFAULT_FAN_DOWN_TIMEOUT_MS = 10_000;

/** Startup refusals: configuration that must not become a listener. */
export class EdgeStartupError extends Error {
  constructor(message) {
    super(message);
    this.name = "EdgeStartupError";
  }
}

/**
 * Headers a northbound request may carry down the tunnel: hop-by-hop,
 * caller-credential, and caller identity-assertion headers are stripped
 * before framing.
 *
 * @param {Record<string, string|string[]>} [headers]
 * @returns {Record<string, string>}
 */
export function fanDownHeaders(headers = {}) {
  const entries = [];
  for (const [name, value] of Object.entries(forwardHeaders(headers))) {
    const key = String(name).toLowerCase();
    if (CALLER_CREDENTIAL_HEADERS.has(key)) continue;
    if (SPOOFABLE_IDENTITY_HEADERS.includes(key)) continue;
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

/**
 * Hot-reloaded agent channel credential store.
 *
 * File shape: `{ "agents": { "<agentId>": { "tokenSha256": "<hex>",
 * "revoked": false } } }`. The edge stores only SHA-256 digests — never a raw
 * channel token. A missing or unreadable file denies every lookup (a
 * credential table that cannot be read authorizes nobody), and the file is
 * re-read when its mtime changes so a revoke needs no restart.
 *
 * @param {object} options
 * @param {string} options.filePath
 * @returns {{lookup: (token: string) => {agentId: string, revoked: boolean}|null}}
 */
export function createChannelCredentialStore({
  filePath,
  readFile = readFileSync,
  stat = statSync,
} = {}) {
  let cache = { mtimeMs: Number.NaN, agents: [], denyAll: true };

  function load() {
    if (!filePath) return cache;
    let info;
    try {
      info = stat(filePath);
    } catch {
      cache = { mtimeMs: Number.NaN, agents: [], denyAll: true };
      return cache;
    }
    if (info.mtimeMs === cache.mtimeMs) return cache;
    try {
      const raw = JSON.parse(readFile(filePath, "utf8"));
      const agents = Object.entries(raw.agents ?? {})
        .filter(([agentId, entry]) => !agentId.startsWith("_")
          && entry && typeof entry === "object"
          && typeof entry.tokenSha256 === "string")
        .map(([agentId, entry]) => ({
          agentId,
          tokenSha256: entry.tokenSha256.toLowerCase(),
          revoked: entry.revoked === true,
        }));
      cache = { mtimeMs: info.mtimeMs, agents, denyAll: false };
    } catch {
      cache = { mtimeMs: info.mtimeMs, agents: [], denyAll: true };
    }
    return cache;
  }

  return {
    lookup(token) {
      if (typeof token !== "string" || !token) return null;
      const { agents, denyAll } = load();
      if (denyAll) return null;
      const digest = Buffer.from(
        createHash("sha256").update(token).digest("hex"),
        "utf8",
      );
      for (const agent of agents) {
        const expected = Buffer.from(agent.tokenSha256, "utf8");
        if (digest.length === expected.length && timingSafeEqual(digest, expected)) {
          return { agentId: agent.agentId, revoked: agent.revoked };
        }
      }
      return null;
    },
  };
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function normalizeGrants(grants) {
  if (!grants || typeof grants !== "object" || Array.isArray(grants)) return null;
  const entries = Object.entries(grants)
    .filter(([clientId, sites]) => !clientId.startsWith("_") && Array.isArray(sites))
    .map(([clientId, sites]) => [clientId, sites.map(String)]);
  return entries.length ? Object.fromEntries(entries) : null;
}

function assertNoSiteCredentials(sites) {
  for (const site of sites) {
    for (const key of SITE_CREDENTIAL_KEYS) {
      if (new Map(Object.entries(site)).get(key) !== undefined) {
        throw new EdgeStartupError(
          `Relay edge site "${site._name ?? "?"}" carries credential material (${key}). `
          + "The edge holds no site credentials; they exist only in the tenant agent.",
        );
      }
    }
  }
}

function assertBindAllowed(role, host, hasTls) {
  if (hasTls) return;
  if (!isLoopback(host)) {
    throw new EdgeStartupError(
      `Relay edge ${role} bind ${host} requires TLS. `
      + "Plain listeners are permitted on loopback only, and only when explicitly allowed.",
    );
  }
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}

/**
 * Start the relay edge: an authenticated northbound MCP listener and the
 * agent channel listener the tenant dials into.
 *
 * @param {object} options
 * @param {{issuer: string, audience: string}} options.auth Inbound
 *   resource-server config (`resolveInboundAuthConfig` shape). Mandatory.
 * @param {object} options.grants Non-empty client-id → site-name grant table.
 * @param {Array<{_name: string}>} options.sites Credential-free catalog.
 * @param {string} [options.defaultSite]
 * @param {{lookup: Function}} options.channelCredentials Agent channel store.
 * @param {string} [options.bindHost] Northbound bind (default loopback).
 * @param {string} [options.agentBindHost] Agent channel bind (default loopback).
 * @param {number} [options.port] Northbound port (0 = ephemeral).
 * @param {number} [options.agentPort] Agent channel port (0 = ephemeral).
 * @param {{cert: string|Buffer, key: string|Buffer}} [options.tls]
 * @param {boolean} [options.allowHttpLoopback] Permit plain listeners on loopback.
 * @param {?object} [options.rateLimiter] Optional rate limiter (rate-limit.js).
 * @param {number} [options.fanDownTimeoutMs]
 * @param {typeof fetch} [options.fetchFn] Issuer discovery/JWKS fetch.
 * @param {?{recordListen: Function, recordConnect: Function}} [options.ledger]
 * @returns {Promise<object>}
 */
export async function startEdge({
  auth,
  grants,
  sites,
  defaultSite,
  channelCredentials,
  bindHost = "127.0.0.1",
  agentBindHost = "127.0.0.1",
  port = 0,
  agentPort = 0,
  tls = null,
  allowHttpLoopback = false,
  rateLimiter = null,
  fanDownTimeoutMs = DEFAULT_FAN_DOWN_TIMEOUT_MS,
  fetchFn = fetch,
  ledger = null,
} = {}) {
  if (!auth?.issuer || !auth?.audience) {
    throw new EdgeStartupError(
      "Relay edge requires an inbound OAuth resource server: set auth.issuer and "
      + "auth.audience. There is no shared-bearer or unauthenticated mode on this "
      + "entry point, at any bind host including loopback.",
    );
  }
  const grantTable = normalizeGrants(grants);
  if (!grantTable) {
    throw new EdgeStartupError(
      "Relay edge refuses to start without a non-empty auth.grants table. "
      + "The library's all-sites fallback does not apply to this entry point.",
    );
  }
  if (typeof channelCredentials?.lookup !== "function") {
    throw new EdgeStartupError(
      "Relay edge requires an agent channel credential store; without one no "
      + "tenant channel could ever be authorized.",
    );
  }
  const catalog = Array.isArray(sites) ? sites : [];
  if (!catalog.length) {
    throw new EdgeStartupError("Relay edge requires a non-empty site catalog.");
  }
  assertNoSiteCredentials(catalog);
  const hasTls = Boolean(tls?.cert && tls?.key);
  if (!hasTls && !allowHttpLoopback) {
    throw new EdgeStartupError(
      "Relay edge requires TLS (tls.cert and tls.key), or an explicit "
      + "loopback-only plain-listener opt-in.",
    );
  }
  assertBindAllowed("northbound", bindHost, hasTls);
  assertBindAllowed("agent-channel", agentBindHost, hasTls);

  const inbound = await createInboundHttpsAuth({ inboundCfg: auth, fetchFn });
  const targetRelay = createLocalRelay({ sites: catalog, grants: grantTable, defaultSite });
  const broker = createRequestBroker({ timeoutMs: fanDownTimeoutMs });

  let session = null;

  const channelServer = (hasTls ? createTlsServer(tls) : createNetServer())
    .on("connection", handleChannelSocket)
    .on("secureConnection", handleChannelSocket);

  function handleChannelSocket(socket) {
    // Plain server emits "connection"; the TLS server emits both "connection"
    // (raw) and "secureConnection" (cleartext). Attach once, post-handshake.
    if (hasTls && !socket.encrypted) return;
    attachFramer(socket, (frame) => {
      if (frame.type === "hello") {
        const record = channelCredentials.lookup(frame.token);
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
        if (session && session.socket !== socket) session.socket.destroy();
        session = { socket, token: frame.token, agentId: record.agentId };
        writeFrame(socket, { type: "hello-ok", agent: { agentId: record.agentId } });
        return;
      }
      if (frame.type === "mcp-response") {
        broker.settle(frame);
        return;
      }
      // Any other frame type on the agent channel is a protocol violation.
      socket.destroy();
    });
    socket.on("close", () => {
      if (session?.socket === socket) {
        session = null;
        broker.rejectAll(new Error("Relay agent channel closed."));
      }
    });
  }

  async function fanDown(req, res, body) {
    const identity = req.mcpIdentity ?? null;
    if (!identity) {
      // The authenticate arm always sets an identity; a missing one means
      // this handler was reached outside that arm. Refuse.
      jsonResponse(res, 403, { error: "not_entitled" });
      return;
    }

    // Entitlement at the seam, before anything about the tenant is revealed:
    // an unlisted client learns nothing, not even whether an agent exists.
    const granted = resolveGrantedSites(identity, catalog, grantTable);
    if (!granted.length) {
      jsonResponse(res, 403, { error: "not_entitled" });
      return;
    }
    if (body?.method === "tools/call") {
      try {
        targetRelay.resolve(identity, body?.params?.arguments ?? {});
      } catch {
        jsonResponse(res, 403, { error: "not_entitled" });
        return;
      }
    }

    if (!session) {
      jsonResponse(res, 503, { error: "no_agent" });
      return;
    }
    const record = channelCredentials.lookup(session.token);
    if (!record || record.revoked) {
      jsonResponse(res, 403, { error: "revoked", bound: EDGE_REVOCATION_BOUND.name });
      return;
    }

    const id = randomUUID();
    const waited = broker.track(id);
    const wrote = writeFrame(session.socket, {
      type: "mcp-request",
      id,
      method: req.method,
      url: "/mcp",
      headers: fanDownHeaders(req.headers),
      identity,
      body,
    });
    if (!wrote) {
      broker.settle({ id, status: 503 });
      jsonResponse(res, 503, { error: "no_agent" });
      return;
    }

    let result;
    try {
      result = await waited;
    } catch {
      jsonResponse(res, 502, { error: "fan_down_failed" });
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(forwardHeaders(result.headers ?? {}))
        .filter(([name]) => String(name).toLowerCase() !== "mcp-session-id"),
    );
    res.writeHead(result.status || 200, headers);
    res.end(result.body ?? "");
  }

  const requestHandler = createMcpRequestHandler({
    authenticate: (req) => inbound.authenticate(req),
    protectedResource: inbound.protectedResource,
    modernHandler: fanDown,
    // Northbound is stateless 2026-07-28 only: sessionful legacy traffic is
    // refused, so no Mcp-Session-Id ever exists in either direction.
    legacyHandler: createLegacySessionHandler({
      buildServer: () => {
        throw new Error("unreachable: legacy transport is rejected at the edge");
      },
      mode: "reject",
    }),
    toolCount: 0,
    rateLimiter,
  });

  const northServer = hasTls
    ? createHttpsServer(tls, (req, res) => { void requestHandler(req, res); })
    : createHttpServer((req, res) => { void requestHandler(req, res); });

  const channelAddr = await listen(channelServer, agentBindHost, agentPort, "edge-agent-channel");
  const northAddr = await listen(northServer, bindHost, port, "edge-northbound");

  function listen(server, host, wantedPort, role) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(wantedPort, host, () => {
        const address = server.address();
        const bound = { host: address.address, port: address.port };
        ledger?.recordListen(role, bound);
        resolve(bound);
      });
    });
  }

  const scheme = hasTls ? "https" : "http";
  return {
    northboundUrl: `${scheme}://${northAddr.host}:${northAddr.port}/mcp`,
    port: northAddr.port,
    agentPort: channelAddr.port,
    resourceMetadataUrl: inbound.resourceMetadataUrl,
    get hasAgent() {
      return Boolean(session);
    },
    get agentId() {
      return session?.agentId ?? null;
    },
    async close() {
      session?.socket.destroy();
      session = null;
      broker.rejectAll(new Error("Relay edge closed."));
      await closeServer(channelServer);
      await closeServer(northServer);
    },
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
