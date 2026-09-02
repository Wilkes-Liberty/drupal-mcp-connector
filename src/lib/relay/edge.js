/**
 * Relay northbound edge (#232, #242, #244, #247, #250) — DEV-294 AC4, DEV-122
 * isolation, DEV-124 tenant routing, DEV-123 actor mapping, DEV-125 policy digest.
 *
 * Terminates northbound MCP over the OAuth resource server and fans requests
 * down outbound tenant-agent channels. The edge proposes; the tenant-side
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
 *   - Tunnel identity is the tenant boundary. Agent sessions are keyed by
 *     `agentId`; channel records may bind `sites`. A second unscoped agent
 *     or overlapping site claim is denied at hello. Fan-down selects the
 *     unique bound agent from server-owned grants. Single unscoped agent
 *     remains the DEV-294 compatibility path.
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
import { isWriteLikeCall } from "../operations.js";
import { DIAGNOSTIC_TOOLS, resolveActor, resolveGrantedSites, resolvePolicy } from "../principal.js";
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

/**
 * Normalize a channel-record `sites` list. Empty / missing means unscoped
 * (legal only as the sole connected agent — the DEV-294 compatibility path).
 *
 * @param {unknown} sites
 * @returns {string[]}
 */
export function boundSiteNames(sites) {
  if (!Array.isArray(sites)) return [];
  return sites.map(String).filter((name) => name && !name.startsWith("_"));
}

/**
 * Decide whether a hello may join the agent-channel session table.
 *
 * @param {object} params
 * @param {{agentId: string, revoked?: boolean, sites?: string[]|null}|null} params.record
 * @param {Array<{agentId: string, sites: string[]|null}>} [params.sessions]
 *   Currently connected agents, excluding a reconnect of the same agentId.
 * @param {Iterable<string>} [params.catalogNames]
 * @returns {{ok: true, sites: string[]|null}|{ok: false, reason: string}}
 */
export function acceptAgentHello({ record, sessions = [], catalogNames = [] } = {}) {
  if (!record || typeof record.agentId !== "string" || !record.agentId) {
    return { ok: false, reason: "unauthenticated" };
  }
  if (record.revoked) return { ok: false, reason: "revoked" };

  const known = new Set([...catalogNames].map(String));
  let incoming = boundSiteNames(record.sites);
  if (incoming.length && known.size) {
    incoming = incoming.filter((name) => known.has(name));
    if (!incoming.length) return { ok: false, reason: "unbound_tenant" };
  }
  const incomingScoped = incoming.length > 0;
  const others = sessions.filter((session) => session.agentId !== record.agentId);

  if (others.length === 0) {
    return { ok: true, sites: incomingScoped ? incoming : null };
  }
  if (!incomingScoped) return { ok: false, reason: "unbound_tenant" };
  if (others.some((session) => !boundSiteNames(session.sites).length)) {
    return { ok: false, reason: "unbound_tenant" };
  }
  const claimed = new Set(others.flatMap((session) => boundSiteNames(session.sites)));
  if (incoming.some((name) => claimed.has(name))) {
    return { ok: false, reason: "overlapping_tenant" };
  }
  return { ok: true, sites: incoming };
}

/**
 * Pick the unique tenant agent this principal may use.
 *
 * @param {object} params
 * @param {string[]} params.grantedSiteNames
 * @param {string|null} [params.targetName]
 * @param {Array<{agentId: string, sites: string[]|null}>} params.sessions
 * @returns {{session: object|null, reason: "not_entitled"|"no_agent"|null}}
 */
export function selectTenantSession({
  grantedSiteNames = [],
  targetName = null,
  sessions = [],
} = {}) {
  if (!grantedSiteNames.length) return { session: null, reason: "not_entitled" };
  if (targetName && !grantedSiteNames.includes(targetName)) {
    return { session: null, reason: "not_entitled" };
  }
  const needed = targetName ? [targetName] : [...grantedSiteNames];
  if (!sessions.length) return { session: null, reason: "no_agent" };

  const scoped = [];
  const unscoped = [];
  for (const session of sessions) {
    if (boundSiteNames(session.sites).length) scoped.push(session);
    else unscoped.push(session);
  }

  if (unscoped.length && scoped.length) {
    return { session: null, reason: "no_agent" };
  }
  if (unscoped.length === 1 && sessions.length === 1) {
    return { session: unscoped[0], reason: null };
  }
  if (unscoped.length > 1) return { session: null, reason: "no_agent" };

  const matches = scoped.filter((session) => {
    const names = new Set(boundSiteNames(session.sites));
    return needed.every((name) => names.has(name));
  });
  if (matches.length === 1) return { session: matches[0], reason: null };
  if (matches.length > 1) return { session: null, reason: "not_entitled" };

  const partial = scoped.filter((session) => {
    const names = new Set(boundSiteNames(session.sites));
    return needed.some((name) => names.has(name));
  });
  if (partial.length > 0 && needed.length > 1) {
    return { session: null, reason: "not_entitled" };
  }
  return { session: null, reason: "no_agent" };
}

/**
 * Resolve tenant and target from server-owned grants. Caller `tenant` is a
 * confirming hint inside the grant, never authority. When `tenantGrants` is
 * omitted, tenant is derived from the unique agent covering the site grant
 * (DEV-122 / DEV-294 compatibility).
 *
 * @param {object} params
 * @param {object|null} params.identity
 * @param {string|null} [params.callerTenant]
 * @param {object|null} [params.tenantGrants]
 * @param {string[]} params.grantedSiteNames
 * @param {string|null} [params.targetName]
 * @param {Array<{agentId: string, sites: string[]|null}>} params.sessions
 * @returns {{session: object|null, tenant: string|null, target: string|null, source: string, reason: "not_entitled"|"no_agent"|null}}
 */
export function resolveTenantRoute({
  identity,
  callerTenant = null,
  tenantGrants = null,
  grantedSiteNames = [],
  targetName = null,
  sessions = [],
} = {}) {
  if (tenantGrants) {
    const listed = identity?.clientId
      ? new Map(Object.entries(tenantGrants)).get(identity.clientId)
      : undefined;
    const grantedTenants = grantIds(listed);
    if (!grantedTenants.length) {
      return {
        session: null, tenant: null, target: targetName, source: "grant", reason: "not_entitled",
      };
    }
    if (callerTenant && !grantedTenants.includes(callerTenant)) {
      return {
        session: null, tenant: null, target: targetName, source: "grant", reason: "not_entitled",
      };
    }
    if (!callerTenant && grantedTenants.length > 1) {
      return {
        session: null, tenant: null, target: targetName, source: "grant", reason: "not_entitled",
      };
    }
    const tenant = callerTenant || grantedTenants[0];
    const session = sessions.find((entry) => entry.agentId === tenant) ?? null;
    if (!session) {
      return {
        session: null, tenant, target: targetName, source: "grant", reason: "no_agent",
      };
    }
    const tenantSites = boundSiteNames(session.sites);
    const allowed = tenantSites.length
      ? grantedSiteNames.filter((name) => tenantSites.includes(name))
      : grantedSiteNames;
    if (targetName && !allowed.includes(targetName)) {
      return {
        session: null, tenant, target: targetName, source: "grant", reason: "not_entitled",
      };
    }
    if (!targetName && grantedSiteNames.length && allowed.length === 0) {
      return {
        session: null, tenant, target: targetName, source: "grant", reason: "not_entitled",
      };
    }
    return { session, tenant, target: targetName, source: "grant", reason: null };
  }

  const selected = selectTenantSession({ grantedSiteNames, targetName, sessions });
  return {
    session: selected.session,
    tenant: selected.session?.agentId ?? null,
    target: targetName,
    source: "grant",
    reason: selected.reason,
  };
}

function callerTenantHint(args = {}) {
  const value = new Map(Object.entries(args ?? {})).get("tenant");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const CALLER_HINT_KEYS = Object.freeze(["tenant", "actor", "delegator", "policy", "digest"]);

function stripCallerHints(body) {
  const args = body?.params?.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return body;
  const bag = new Map(Object.entries(args));
  let changed = false;
  for (const key of CALLER_HINT_KEYS) {
    if (bag.has(key)) {
      bag.delete(key);
      changed = true;
    }
  }
  if (!changed) return body;
  return { ...body, params: { ...body.params, arguments: Object.fromEntries(bag) } };
}

function identityWithGrant(identity, { tenant, actor = null, delegator = null, policy = null }) {
  const next = { ...identity, tenant };
  if (actor) next.actor = actor;
  if (delegator) next.delegator = delegator;
  if (policy) next.policy = policy;
  return Object.freeze(next);
}

/**
 * Canonical form of a tenant site bind. Null and empty both mean unscoped.
 *
 * @param {unknown} sites
 * @returns {string}
 */
export function siteBindingKey(sites) {
  const names = boundSiteNames(sites);
  return names.length ? names.slice().sort().join("\0") : "";
}

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
 * "sites": ["site-name"], "revoked": false } } }`. The edge stores only
 * SHA-256 digests — never a raw channel token. `sites` binds the tunnel to
 * catalog names (the tenant boundary). Omitted `sites` is unscoped and is
 * only accepted as the sole connected agent. A missing or unreadable file
 * denies every lookup (a credential table that cannot be read authorizes
 * nobody), and the file is re-read when its mtime changes so a revoke needs
 * no restart.
 *
 * @param {object} options
 * @param {string} options.filePath
 * @returns {{lookup: (token: string) => {agentId: string, revoked: boolean, sites: string[]|null}|null}}
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
          sites: Array.isArray(entry.sites) ? boundSiteNames(entry.sites) : null,
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
          return { agentId: agent.agentId, revoked: agent.revoked, sites: agent.sites };
        }
      }
      return null;
    },
  };
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function grantIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(
    values.map((value) => String(value).trim()).filter((value) => value && !value.startsWith("_")),
  )];
}

function normalizeGrants(grants) {
  if (!grants || typeof grants !== "object" || Array.isArray(grants)) return null;
  const entries = Object.entries(grants)
    .filter(([clientId, sites]) => !clientId.startsWith("_") && Array.isArray(sites))
    .map(([clientId, sites]) => [clientId, grantIds(sites)]);
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
 * @param {object|null} [options.tenantGrants] Optional client-id → tenant
 *   agent-id table. When present, tenant routing is grant-authoritative.
 * @param {object|null} [options.actors] Optional principal → Drupal actor
 *   table (`sub` / `azp` → `{ uuid, delegators? }`). When present, write-like
 *   tools/call require a mapping.
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
  tenantGrants = null,
  actors = null,
  policies = null,
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
  const tenantGrantTable = normalizeGrants(tenantGrants);
  const actorTable = actors && typeof actors === "object" && !Array.isArray(actors)
    ? actors
    : null;
  const policyTable = policies && typeof policies === "object" && !Array.isArray(policies)
    ? policies
    : null;
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

  /** @type {Map<string, {socket: object, token: string, agentId: string, sites: string[]|null}>} */
  const sessions = new Map();
  const catalogNames = catalog.map((site) => site._name);

  const channelServer = (hasTls ? createTlsServer(tls) : createNetServer())
    .on("connection", handleChannelSocket)
    .on("secureConnection", handleChannelSocket);

  function handleChannelSocket(socket) {
    // Plain server emits "connection"; the TLS server emits both "connection"
    // (raw) and "secureConnection" (cleartext). Attach once, post-handshake.
    if (hasTls && !socket.encrypted) return;
    let agentId = null;
    attachFramer(socket, (frame) => {
      if (frame.type === "hello") {
        const record = channelCredentials.lookup(frame.token);
        const others = [...sessions.values()].filter((entry) => entry.socket !== socket);
        const decision = acceptAgentHello({
          record,
          sessions: others,
          catalogNames,
        });
        if (!decision.ok) {
          writeFrame(socket, { type: "denied", reason: decision.reason });
          socket.end();
          return;
        }
        const existing = sessions.get(record.agentId);
        if (existing && existing.socket !== socket) existing.socket.destroy();
        agentId = record.agentId;
        sessions.set(agentId, {
          socket,
          token: frame.token,
          agentId,
          sites: decision.sites,
        });
        writeFrame(socket, { type: "hello-ok", agent: { agentId } });
        return;
      }
      if (frame.type === "mcp-response") {
        if (!agentId) {
          socket.destroy();
          return;
        }
        broker.settle(frame, { owner: agentId });
        return;
      }
      // Any other frame type on the agent channel is a protocol violation.
      socket.destroy();
    });
    socket.on("close", () => {
      const current = agentId ? sessions.get(agentId) : null;
      if (current?.socket === socket) {
        sessions.delete(agentId);
        broker.rejectByOwner(agentId, new Error("Relay agent channel closed."));
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
    const args = body?.params?.arguments ?? {};
    const callerTenant = callerTenantHint(args);
    const siteArgs = { ...args };
    delete siteArgs.tenant;
    let targetName = null;
    if (body?.method === "tools/call") {
      try {
        targetName = targetRelay.resolve(identity, siteArgs).name;
      } catch {
        jsonResponse(res, 403, { error: "not_entitled" });
        return;
      }
    }

    const mapped = resolveActor({ identity, actors: actorTable });
    const boundPolicy = resolvePolicy({ identity, policies: policyTable });
    const isCall = body?.method === "tools/call";
    const toolName = isCall && typeof body?.params?.name === "string" && body.params.name.trim()
      ? body.params.name.trim()
      : null;
    if (mapped.required && mapped.reason && isCall && (!toolName || isWriteLikeCall(toolName, args))) {
      jsonResponse(res, 403, { error: "not_entitled" });
      return;
    }
    if (
      boundPolicy.required && boundPolicy.reason && isCall
      && (!toolName || !DIAGNOSTIC_TOOLS.has(toolName))
    ) {
      jsonResponse(res, 403, { error: "not_entitled" });
      return;
    }

    const selected = resolveTenantRoute({
      identity,
      callerTenant,
      tenantGrants: tenantGrantTable,
      grantedSiteNames: granted.map((site) => site._name),
      targetName,
      sessions: [...sessions.values()],
    });
    if (!selected.session) {
      const entitled = selected.reason === "not_entitled";
      jsonResponse(res, entitled ? 403 : 503, {
        error: entitled ? "not_entitled" : "no_agent",
      });
      return;
    }
    const record = channelCredentials.lookup(selected.session.token);
    if (!record || record.revoked) {
      jsonResponse(res, 403, { error: "revoked", bound: EDGE_REVOCATION_BOUND.name });
      return;
    }
    if (siteBindingKey(record.sites) !== siteBindingKey(selected.session.sites)) {
      selected.session.socket.destroy();
      jsonResponse(res, 503, { error: "no_agent" });
      return;
    }

    const id = randomUUID();
    const waited = broker.track(id, { owner: selected.session.agentId });
    const routedIdentity = identityWithGrant(identity, {
      tenant: selected.tenant,
      actor: mapped.actor,
      delegator: mapped.delegator,
      policy: boundPolicy.policy,
    });
    const wrote = writeFrame(selected.session.socket, {
      type: "mcp-request",
      id,
      method: req.method,
      url: "/mcp",
      headers: fanDownHeaders(req.headers),
      identity: routedIdentity,
      body: stripCallerHints(body),
      correlation: {
        requestId: id,
        tenant: selected.tenant,
        target: selected.target,
        source: selected.source,
        ...(mapped.actor ? { actor: mapped.actor } : {}),
        ...(mapped.delegator ? { delegator: mapped.delegator } : {}),
        ...(boundPolicy.policy ? { policyDigest: boundPolicy.policy } : {}),
      },
    });
    if (!wrote) {
      broker.settle({ id, status: 503 }, { owner: selected.session.agentId });
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
  let closed = false;
  return {
    northboundUrl: `${scheme}://${northAddr.host}:${northAddr.port}/mcp`,
    port: northAddr.port,
    agentPort: channelAddr.port,
    resourceMetadataUrl: inbound.resourceMetadataUrl,
    get hasAgent() {
      return sessions.size > 0;
    },
    get agentId() {
      if (sessions.size !== 1) return null;
      return sessions.keys().next().value;
    },
    get agentIds() {
      return [...sessions.keys()];
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const entry of sessions.values()) entry.socket.destroy();
      sessions.clear();
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
