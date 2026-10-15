/**
 * HTTP request handler for the Streamable-HTTP MCP transport.
 *
 * Extracted from index.js so the routing/auth/health/404 behavior is unit
 * testable without standing up a real server. The entry point wires the bearer
 * check plus strict modern and sessionful legacy handler arms; tests inject
 * stubs around that same required pair.
 */

import { randomUUID } from "node:crypto";
import { isInitializeRequest, isJsonContentType, isLegacyRequest } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toWebRequest } from "@modelcontextprotocol/node";
import { parseBearerToken, writeUnauthorized } from "./http-auth.js";
import { resolveClientAddress } from "./client-address.js";
import { rateLimitAddressKey, rateLimitPrincipalKey, UNRESOLVED_PRINCIPAL_RATE_KEY } from "./rate-limit.js";
import {
  attachHttpAudit,
  runWithHttpAudit,
  markHttpAuditHostRefused,
  markHttpAuditOriginRefused,
  createHttpAuditWriter,
  defaultHttpAuditSink,
  httpAuditHostDenied,
  httpAuditOriginDenied,
} from "./http-audit.js";
import { publicRequestMetricFields } from "./ops-metrics.js";
import {
  LOOPBACK_HOSTS,
  MCP_PROTOCOL_VERSIONS,
  UNSUPPORTED_PROTOCOL_VERSION_CODE,
  hostAllowed,
  isJsonRpcBatch,
  isSupportedProtocolVersion,
  mcpAcceptOk,
  originAllowed,
  sessionPrincipalKey,
} from "./http-transport.js";
import { LOCAL_OPERATOR, runWithIdentity } from "./principal.js";

/**
 * Routes that may be reached without a resolved identity. Health is a mesh
 * liveness probe and must not expose tool data. RFC 9728 protected-resource
 * metadata must stay reachable so a client can discover how to authenticate.
 * Everything else fails closed with 401 (DEV-845). Not exported: tests and
 * evals go through {@link isUnauthenticatedRoute}.
 */
const UNAUTHENTICATED_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/health" }),
  Object.freeze({ method: "GET", path: "/.well-known/oauth-protected-resource" }),
]);

/** Same bound as the outbound server-tools session cache in server-tools.js. */
export const LEGACY_SESSION_CAP = 128;

/** Idle 2025 sessions are closed on the next request after this many ms. */
export const LEGACY_SESSION_IDLE_MS = 30 * 60 * 1000;

/** Single MCP endpoint path. Sessionless GET/DELETE are 405 after auth. */
export const MCP_HTTP_PATH = "/mcp";

/** Methods the MCP endpoint accepts after auth (DEV-840). */
export const MCP_HTTP_METHODS = Object.freeze(["POST", "GET", "DELETE"]);

/**
 * Whether an authenticated GET/DELETE without `Mcp-Session-Id` is refused
 * (2026-07-28 has no standalone GET stream). Injectable so eval mutants can
 * skip the 405 without changing the default.
 *
 * @param {string} method
 * @param {unknown} sessionId
 * @returns {boolean}
 */
export function sessionlessMethodRefused(method, sessionId) {
  return (method === "GET" || method === "DELETE") && !sessionId;
}

/**
 * Whether this request may proceed without a resolved identity.
 *
 * @param {string} method
 * @param {string} url Path or full URL (query string is ignored).
 * @returns {boolean}
 */
export function isUnauthenticatedRoute(method, url) {
  const path = String(url || "").split("?")[0];
  for (const route of UNAUTHENTICATED_ROUTES) {
    if (route.method !== method) continue;
    if (path === route.path) return true;
    if (
      route.path === "/.well-known/oauth-protected-resource"
      && path.startsWith(`${route.path}/`)
    ) {
      return true;
    }
  }
  return false;
}

function refuseUnresolvedIdentity(res, resourceMetadataUrl) {
  writeUnauthorized(res, {
    error: "invalid_token",
    errorDescription: "Bearer token required",
    resourceMetadata: resourceMetadataUrl,
  });
}

/**
 * JSON-RPC error body with no `id` (Streamable HTTP MAY attach one to an
 * HTTP-level refusal). Used for Host, Origin, and protocol-version denials.
 *
 * @param {import("http").ServerResponse} res
 * @param {number} status
 * @param {{code?: number, message: string, data?: unknown}} error
 */
function writeJsonRpcHttpError(res, status, error) {
  const body = {
    jsonrpc: "2.0",
    error: {
      code: error.code ?? -32000,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
  };
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

class McpHttpClientError extends Error {
  constructor(statusCode, publicMessage) {
    super(publicMessage);
    this.name = "McpHttpClientError";
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

function defaultOnError({ stage }) {
  console.error(`[drupal-mcp-connector] MCP ${stage} failed.`);
}

function reportUnexpected(onError, stage) {
  try {
    onError({ stage });
  } catch {
    // Diagnostics must never replace the controlled transport response.
  }
}

function respondAfterFailure(res, error, onError, stage) {
  if (error instanceof McpHttpClientError && !res.headersSent) {
    res.writeHead(error.statusCode).end(error.publicMessage);
    return;
  }

  reportUnexpected(onError, stage);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(500).end("Internal Server Error");
}

async function readJsonBody(req, maxBodyBytes) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    throw new McpHttpClientError(413, "Request body exceeds the configured limit");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) {
      throw new McpHttpClientError(413, "Request body exceeds the configured limit");
    }
    chunks.push(bytes);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new McpHttpClientError(400, "Malformed JSON request body");
  }
}

/**
 * Build the bounded 2025-era sessionful transport arm.
 *
 * The map is capped at {@link LEGACY_SESSION_CAP} (128, the same bound as
 * the outbound server-tools cache). Sessions idle longer than
 * {@link LEGACY_SESSION_IDLE_MS} are closed on the next request. A new
 * session that would exceed the cap closes the least-recently-used entry
 * first (Map insertion order, refreshed on use). `handler.close()` closes
 * every remaining transport.
 *
 * @param {object} deps
 * @param {(ctx: {era: "legacy"}) => object|Promise<object>} deps.buildServer
 * @param {Map<string, object>} [deps.sessions]
 * @param {"serve"|"reject"} [deps.mode]
 * @param {(options: object) => object} [deps.transportFactory]
 * @param {(identity: object|null|undefined) => ?string} [deps.sessionPrincipalKeyFn]
 *   Injectable principal binder (eval mutants swap this).
 * @param {number} [deps.maxSessions=128] Hard cap (tests inject a smaller one).
 * @param {number} [deps.idleMs] Idle TTL in ms (tests inject a shorter one).
 * @param {() => number} [deps.now] Clock (tests inject a fake).
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse, body?: unknown) => Promise<void>}
 */
export function createLegacySessionHandler({
  buildServer,
  sessions = new Map(),
  mode = "serve",
  transportFactory = (options) => new NodeStreamableHTTPServerTransport(options),
  sessionPrincipalKeyFn = sessionPrincipalKey,
  maxSessions = LEGACY_SESSION_CAP,
  idleMs = LEGACY_SESSION_IDLE_MS,
  now = Date.now,
}) {
  if (mode !== "serve" && mode !== "reject") {
    throw new Error(`Invalid legacy MCP transport mode: "${mode}". Use "serve" or "reject".`);
  }
  if (typeof sessionPrincipalKeyFn !== "function") {
    throw new Error("sessionPrincipalKeyFn must be a function");
  }
  if (!Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error("maxSessions must be a positive integer");
  }

  function methodNotAllowed(res) {
    res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
  }

  async function closeSession(session, sessionId) {
    sessions.delete(sessionId);
    const transport = session?.transport;
    if (!transport) return;
    try {
      if (typeof transport.close === "function") await transport.close();
    } catch {
      // Termination must still drop the id even if the SDK close throws.
    }
  }

  /**
   * Drop sessions whose last use is older than the idle TTL. Mirrors the
   * server-tools cache: the map never holds abandoned ids forever.
   */
  async function evictIdle() {
    if (!Number.isFinite(idleMs) || idleMs < 0) return;
    const cutoff = now() - idleMs;
    for (const [id, session] of [...sessions.entries()]) {
      if ((session.lastUsed ?? 0) <= cutoff) {
        await closeSession(session, id);
      }
    }
  }

  /**
   * Evict the least-recently-used entry until there is room (server-tools.js
   * drops `sessions.keys().next()` at 128).
   */
  async function evictForCapacity() {
    while (sessions.size >= maxSessions) {
      const oldestId = sessions.keys().next().value;
      if (oldestId === undefined) break;
      await closeSession(sessions.get(oldestId), oldestId);
    }
  }

  function touch(sessionId, session) {
    session.lastUsed = now();
    sessions.delete(sessionId);
    sessions.set(sessionId, session);
  }

  async function openSession(identity) {
    const principalKey = sessionPrincipalKeyFn(identity);
    if (!principalKey) {
      throw new McpHttpClientError(403, "Session cannot be bound to this principal");
    }
    await evictForCapacity();
    const transport = transportFactory({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, principalKey, lastUsed: now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = await buildServer({ era: "legacy" });
    await server.connect(transport);
    return transport;
  }

  async function handleLegacy(req, res, body) {
    if (mode === "reject") {
      if (req.method === "GET" || req.method === "DELETE") {
        methodNotAllowed(res);
        return;
      }
      res.writeHead(400).end("Legacy MCP transport is disabled");
      return;
    }

    await evictIdle();

    const sessionId = req.headers["mcp-session-id"];
    const principalKey = sessionPrincipalKeyFn(req.mcpIdentity);

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404).end("Unknown MCP-Session-Id");
        return;
      }
      if (!principalKey || session.principalKey !== principalKey) {
        res.writeHead(403).end("MCP-Session-Id does not belong to this principal");
        return;
      }
      if (req.method === "DELETE") {
        await closeSession(session, sessionId);
        if (!res.headersSent) res.writeHead(200).end();
        return;
      }
      touch(sessionId, session);
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      methodNotAllowed(res);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      res.writeHead(400).end("MCP-Session-Id is required for legacy session requests");
      return;
    }

    if (!principalKey) {
      res.writeHead(403).end("Session cannot be bound to this principal");
      return;
    }

    const transport = await openSession(req.mcpIdentity);
    await transport.handleRequest(req, res, body);
  }

  handleLegacy.close = async () => {
    for (const [id, session] of [...sessions.entries()]) {
      await closeSession(session, id);
    }
  };

  return handleLegacy;
}

/**
 * Build the `(req, res)` handler for the MCP HTTP endpoint.
 *
 * Routes:
 *   - `POST /mcp` — rate- and bearer-gated, then Origin / protocol-version /
 *     Accept checked, body bounded and parsed once, JSON-RPC batches refused,
 *     then classified into exactly one modern-stateless or legacy-sessionful arm.
 *   - `GET|DELETE /mcp` — rate- and bearer-gated. Sessionless GET/DELETE are
 *     405 (2026-07-28 has no standalone GET stream). With `Mcp-Session-Id`,
 *     GET/DELETE are 2025-era session operations bound to the authenticated
 *     principal.
 *   - `GET /health` — unauthenticated liveness probe (`{status: "ok"}`).
 *     No tool catalog or count (DEV-845).
 *   - `GET /.well-known/oauth-protected-resource[/…]` — RFC 9728 metadata.
 *   - `GET /ready` and `GET /metrics` — not served here (DEV-863). They
 *     exist only on the mesh-only ops listener. This handler keeps its
 *     normal 401 (no identity) / 404 (after auth).
 *   - everything else — 401 without a resolved identity, 404 after auth; metered
 *     like /mcp so an unknown path is never a free introspection.
 *
 * A request with no resolved identity is refused before any handler, Drupal
 * call, or budget charge. `allowLocalOperator` is the unauthenticated-loopback
 * exception; it attaches {@link LOCAL_OPERATOR} rather than dispatching as
 * `null`. The loopback shared bearer was removed in 4.0.0 (#231).
 *
 * @param {object} deps
 * @param {(authHeader: any) => boolean} [deps.checkAuth] Pre-dispatch header
 *   predicate used when no authenticator is wired (closed in resource-server
 *   mode, open on unauthenticated loopback). Default: open.
 * @param {(req: import("http").IncomingMessage) => Promise<object>} [deps.authenticate]
 *   Resource-server authenticator. When set, it replaces `checkAuth`.
 * @param {boolean} [deps.allowLocalOperator=false] Unauthenticated loopback
 *   only. After a successful check, attach the local-operator identity.
 *   Default false: missing identity is 401.
 * @param {object|null} [deps.protectedResource] RFC 9728 metadata served unauthenticated.
 * @param {string} [deps.resourceMetadataUrl] RFC 9728 metadata URL included
 *   on every 401 challenge (DEV-877).
 * @param {(req: object, res: object, body?: unknown) => Promise<void>} deps.modernHandler
 * @param {(req: object, res: object, body?: unknown) => Promise<void>} deps.legacyHandler
 * @param {?{check: (key: string) => {allowed: boolean, retryAfterSec: number}, peek?: (key: string) => {allowed: boolean, retryAfterSec: number}}} [deps.rateLimiter]
 *   Address limiter (see rate-limit.js). Unauthenticated `/mcp` requests are
 *   checked against it before auth work (DEV-860). Omit/null to disable.
 * @param {?{check: (key: string) => {allowed: boolean, retryAfterSec: number}}} [deps.principalLimiter]
 *   Post-auth principal limiter. `undefined` reuses `rateLimiter`; `null`
 *   disables the principal gate. Keys come from the validated identity,
 *   never from a caller-supplied header.
 * @param {(req: import("http").IncomingMessage) => string} [deps.clientKey]
 *   Maps a request to the unauthenticated address key (default: trusted-proxy
 *   aware client address; trust none).
 * @param {(identity: object|null|undefined) => ?string} [deps.principalRateKeyFn]
 *   Maps a verified identity to the principal rate-limit key.
 * @param {readonly string[]} [deps.trustedProxies]
 *   CIDR/IP list of peers allowed to set `X-Forwarded-For`. Default empty.
 * @param {number} [deps.maxBodyBytes] Maximum accepted POST body size.
 * @param {typeof toWebRequest} [deps.toWebRequestFn] Injectable Node-to-Web adapter.
 * @param {typeof isLegacyRequest} [deps.isLegacyRequestFn] Injectable SDK era classifier.
 * @param {(event: {stage: string}) => void} [deps.onError] Sanitized diagnostics sink.
 * @param {{write: Function}|null} [deps.auditWriter] Hosted HTTP audit writer
 *   (DEV-858). Default: stderr JSONL (silent under Vitest). `null` disables
 *   the writer (eval mutant). One finish-time row per response.
 * @param {readonly string[]} [deps.allowedOrigins] Normalized Origin allowlist.
 * @param {readonly string[]} [deps.allowedHosts] Normalized Host allowlist
 *   (DEV-861). Defaults to loopback hostnames so unit tests that omit the
 *   production resolver still accept `Host: 127.0.0.1`. An explicit list
 *   (including an empty one) is enforced fail-closed.
 * @param {(origin: unknown, allowlist: readonly string[]) => boolean} [deps.originAllowedFn]
 *   Injectable Origin guard (eval mutants swap this).
 * @param {(host: unknown, allowlist: readonly string[]) => boolean} [deps.hostAllowedFn]
 *   Injectable Host guard (eval mutants swap this).
 * @param {(version: unknown) => boolean} [deps.protocolVersionSupportedFn]
 *   Injectable protocol-version guard (eval mutants swap this).
 * @param {(method: string, accept: unknown) => boolean} [deps.acceptOkFn]
 *   Injectable Accept-header guard.
 * @param {(method: string, url: string) => boolean} [deps.isUnauthenticatedRouteFn]
 *   Injectable unauthenticated-route predicate (eval mutants swap this).
 * @param {(method: string, sessionId: unknown) => boolean} [deps.sessionlessMethodRefusedFn]
 *   Injectable sessionless GET/DELETE 405 guard (eval mutants swap this).
 * @param {(body: unknown) => boolean} [deps.isJsonRpcBatchFn]
 *   Injectable JSON-RPC batch predicate (eval mutants swap this).
 * @param {?{beginRequest: Function, finishRequest: Function}} [deps.metrics]
 *   Optional ops metrics registry (DEV-863). Identity is never stored.
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => Promise<void>}
 */
export function createMcpRequestHandler({
  checkAuth = () => true,
  authenticate = null,
  allowLocalOperator = false,
  protectedResource = null,
  resourceMetadataUrl,
  modernHandler = null,
  legacyHandler = null,
  rateLimiter = null,
  principalLimiter,
  clientKey = null,
  principalRateKeyFn = rateLimitPrincipalKey,
  trustedProxies = [],
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  toWebRequestFn = toWebRequest,
  isLegacyRequestFn = isLegacyRequest,
  onError = defaultOnError,
  auditWriter,
  allowedOrigins = [],
  allowedHosts = LOOPBACK_HOSTS,
  originAllowedFn = originAllowed,
  hostAllowedFn = hostAllowed,
  protocolVersionSupportedFn = isSupportedProtocolVersion,
  acceptOkFn = mcpAcceptOk,
  isUnauthenticatedRouteFn = isUnauthenticatedRoute,
  sessionlessMethodRefusedFn = sessionlessMethodRefused,
  isJsonRpcBatchFn = isJsonRpcBatch,
  metrics = null,
}) {
  if (!modernHandler || !legacyHandler) {
    throw new Error("modernHandler and legacyHandler must be configured together for dual-era routing");
  }
  const injectedPredicates = {
    originAllowedFn,
    protocolVersionSupportedFn,
    acceptOkFn,
    isUnauthenticatedRouteFn,
    sessionlessMethodRefusedFn,
    isJsonRpcBatchFn,
    principalRateKeyFn,
  };
  for (const [name, fn] of Object.entries(injectedPredicates)) {
    if (typeof fn !== "function") {
      throw new Error(`${name} must be a function`);
    }
  }

  const writer = auditWriter === undefined
    ? createHttpAuditWriter({ sink: defaultHttpAuditSink })
    : auditWriter;
  const identityLimiter = principalLimiter !== undefined ? principalLimiter : rateLimiter;

  function requestPath(req) {
    return String(req.url || "").split("?")[0];
  }

  function addressKey(req) {
    if (clientKey) return clientKey(req);
    return rateLimitAddressKey(resolveClientAddress(req, trustedProxies));
  }

  function writeTooManyRequests(res, retryAfterSec) {
    res.writeHead(429, { "Retry-After": String(retryAfterSec) }).end("Too Many Requests");
  }

  /**
   * Any method on `/mcp`: consume the address bucket before any auth work.
   * Bearer-present: atomically reserve a slot (held while introspection is
   * in flight, so a concurrent burst cannot all observe a free bucket);
   * the hold is committed on a failed auth and released for a verified
   * principal, which the principal limiter then charges (DEV-860). A
   * limiter without `reserve` falls back to peek-then-charge.
   *
   * @param {import("http").IncomingMessage} req
   * @param {import("http").ServerResponse} res
   * @returns {boolean} `false` when the request was already refused.
   */
  function gateUnauthenticatedAddressLimit(req, res) {
    if (!rateLimiter) return true;
    const key = addressKey(req);
    const hasBearer = Boolean(parseBearerToken(req.headers.authorization));
    if (!hasBearer) {
      const verdict = rateLimiter.check(key);
      if (!verdict.allowed) {
        writeTooManyRequests(res, verdict.retryAfterSec);
        return false;
      }
      return true;
    }
    if (typeof rateLimiter.reserve === "function") {
      const hold = rateLimiter.reserve(key);
      if (!hold.allowed) {
        writeTooManyRequests(res, hold.retryAfterSec);
        return false;
      }
      req.mcpAddressHold = hold;
      return true;
    }
    if (typeof rateLimiter.peek === "function") {
      const verdict = rateLimiter.peek(key);
      if (!verdict.allowed) {
        writeTooManyRequests(res, verdict.retryAfterSec);
        return false;
      }
    }
    return true;
  }

  /**
   * After any error response from the bearer path (401, 403, the 503 an
   * unreachable issuer produces, …), charge the address bucket so a spray
   * of bad, under-scoped, or outage-probing bearers is eventually refused
   * before the next introspection. None of those reach the principal gate,
   * so without this they could keep invoking the issuer for free. With a
   * reservation the hold is committed; otherwise the bucket is charged now.
   *
   * @param {import("http").IncomingMessage} req
   * @param {import("http").ServerResponse} res
   */
  function noteFailedAuthAddress(req, res) {
    if (!rateLimiter) return;
    if (!parseBearerToken(req.headers.authorization)) return;
    const failed = typeof res.statusCode === "number" && res.statusCode >= 400;
    if (req.mcpAddressHold) {
      if (failed) req.mcpAddressHold.commit();
      else req.mcpAddressHold.release();
      req.mcpAddressHold = null;
      return;
    }
    if (failed) rateLimiter.check(addressKey(req));
  }

  /** A verified principal gives its address hold back; the principal gate charges it instead. */
  function releaseAddressHold(req) {
    if (req.mcpAddressHold) {
      req.mcpAddressHold.release();
      req.mcpAddressHold = null;
    }
  }

  /**
   * Authenticated `/mcp`: consume the verified-principal bucket. A 429 here
   * is only `Too Many Requests` — no tool catalog or handler dispatch.
   *
   * @param {import("http").IncomingMessage} req
   * @param {import("http").ServerResponse} res
   * @returns {boolean}
   */
  function gatePrincipalLimit(req, res) {
    if (!identityLimiter) return true;
    // No principal key (token without sub / client_id): one shared
    // fail-closed bucket, never the client address, so the same token cannot
    // rotate source addresses for fresh quota.
    const principalKey = principalRateKeyFn(req.mcpIdentity) || UNRESOLVED_PRINCIPAL_RATE_KEY;
    const verdict = identityLimiter.check(principalKey);
    if (!verdict.allowed) {
      writeTooManyRequests(res, verdict.retryAfterSec);
      return false;
    }
    return true;
  }

  async function gateAuth(req, res) {
    if (authenticate) {
      let result;
      try {
        result = await authenticate(req);
      } catch {
        writeUnauthorized(res, {
          error: "invalid_token",
          errorDescription: "Token validation failed",
          resourceMetadata: resourceMetadataUrl,
        });
        return false;
      }
      if (!result.ok) {
        res.writeHead(result.status, result.headers).end(result.body);
        return false;
      }
      if (!result.identity) {
        refuseUnresolvedIdentity(res, resourceMetadataUrl);
        return false;
      }
      req.mcpIdentity = result.identity;
      return true;
    }
    if (!checkAuth(req.headers["authorization"])) {
      writeUnauthorized(res, {
        error: "invalid_token",
        errorDescription: "Bearer token required",
        resourceMetadata: resourceMetadataUrl,
      });
      return false;
    }
    if (allowLocalOperator) {
      req.mcpIdentity = LOCAL_OPERATOR;
      return true;
    }
    if (!req.mcpIdentity) {
      refuseUnresolvedIdentity(res, resourceMetadataUrl);
      return false;
    }
    return true;
  }

  function dispatchWithIdentity(req, fn) {
    return runWithHttpAudit(req, () => runWithIdentity(req.mcpIdentity, fn, { surface: "network" }));
  }

  return async function handle(req, res) {
    if (writer) attachHttpAudit(req, res, writer);
    const path = requestPath(req);
    metrics?.beginRequest();
    try {
      await dispatchPublic(req, res, path);
    } finally {
      metrics?.finishRequest(publicRequestMetricFields(req, res, {
        originDenied: httpAuditOriginDenied(req),
        hostDenied: httpAuditHostDenied(req),
      }));
    }
  };

  async function dispatchPublic(req, res, path) {
    if (isUnauthenticatedRouteFn(req.method, path)) {
      if (path === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (!protectedResource) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(protectedResource));
      return;
    }

    // Everything past the public routes is metered: every method on /mcp,
    // and every unknown path too. An unsupported verb or a bogus path still
    // carries a bearer through `gateAuth` (unknown paths keep the DEV-877 /
    // DEV-845 401 challenge before their 404), and introspection must never
    // be free. Method and path validation come after.
    if (!gateUnauthenticatedAddressLimit(req, res)) return;

    if (!await gateAuth(req, res)) {
      noteFailedAuthAddress(req, res);
      return;
    }
    releaseAddressHold(req);

    if (!gatePrincipalLimit(req, res)) return;

    if (path === MCP_HTTP_PATH) {
      if (!hostAllowedFn(req.headers.host, allowedHosts)) {
        markHttpAuditHostRefused(req);
        writeJsonRpcHttpError(res, 403, { message: "Forbidden host" });
        return;
      }
      if (!originAllowedFn(req.headers.origin, allowedOrigins)) {
        markHttpAuditOriginRefused(req);
        writeJsonRpcHttpError(res, 403, { message: "Forbidden origin" });
        return;
      }
      const protocolVersion = req.headers["mcp-protocol-version"];
      // Only an absent header skips the check: a present, empty value is unsupported.
      if (protocolVersion !== undefined
        && !protocolVersionSupportedFn(String(protocolVersion).trim())) {
        writeJsonRpcHttpError(res, 400, {
          code: UNSUPPORTED_PROTOCOL_VERSION_CODE,
          message: "Unsupported protocol version",
          data: { supported: [...MCP_PROTOCOL_VERSIONS] },
        });
        return;
      }
      if (!acceptOkFn(req.method, req.headers.accept)) {
        res.writeHead(406).end("Not Acceptable");
        return;
      }
    }

    if (path === MCP_HTTP_PATH && (req.method === "GET" || req.method === "DELETE")) {
      if (sessionlessMethodRefusedFn(req.method, req.headers["mcp-session-id"])) {
        res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
        return;
      }
      try {
        await dispatchWithIdentity(req, () => legacyHandler(req, res));
      } catch (error) {
        respondAfterFailure(res, error, onError, "legacy-dispatch");
      }
      return;
    }

    if (req.method === "POST" && path === MCP_HTTP_PATH) {
      if (!isJsonContentType(req.headers["content-type"])) {
        res.writeHead(415).end("Content-Type must be application/json");
        return;
      }
      let stage = "body-read";
      try {
        const body = await readJsonBody(req, maxBodyBytes);
        if (isJsonRpcBatchFn(body)) {
          writeJsonRpcHttpError(res, 400, { code: -32600, message: "JSON-RPC batch is not supported" });
          return;
        }
        stage = "request-conversion";
        const request = await toWebRequestFn(req, body);
        stage = "classification";
        const legacy = await isLegacyRequestFn(request, body);
        const selectedHandler = legacy ? legacyHandler : modernHandler;
        stage = legacy ? "legacy-dispatch" : "modern-dispatch";
        await dispatchWithIdentity(req, () => selectedHandler(req, res, body));
      } catch (error) {
        respondAfterFailure(res, error, onError, stage);
      }
      return;
    }

    res.writeHead(404).end("Not found");
  }
}
