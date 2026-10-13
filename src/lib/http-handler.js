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
import { writeUnauthorized } from "./http-auth.js";
import {
  attachHttpAudit,
  markHttpAuditHostRefused,
  markHttpAuditOriginRefused,
  createHttpAuditWriter,
  defaultHttpAuditSink,
} from "./http-audit.js";
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
 * Everything else fails closed with 401 (DEV-845).
 */
export const UNAUTHENTICATED_ROUTES = Object.freeze([
  Object.freeze({ method: "GET", path: "/health" }),
  Object.freeze({ method: "GET", path: "/.well-known/oauth-protected-resource" }),
]);

/**
 * Whether this request may proceed without a resolved identity.
 *
 * @param {string} method
 * @param {string} url Path or full URL (query string is ignored).
 * @returns {boolean}
 */
export function isUnauthenticatedRoute(method, url) {
  const path = String(url || "").split("?")[0];
  if (method !== "GET") return false;
  if (path === "/health") return true;
  return path === "/.well-known/oauth-protected-resource"
    || path.startsWith("/.well-known/oauth-protected-resource/");
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
 * @param {object} deps
 * @param {(ctx: {era: "legacy"}) => object|Promise<object>} deps.buildServer
 * @param {Map<string, object>} [deps.sessions]
 * @param {"serve"|"reject"} [deps.mode]
 * @param {(options: object) => object} [deps.transportFactory]
 * @param {(identity: object|null|undefined) => ?string} [deps.sessionPrincipalKeyFn]
 *   Injectable principal binder (eval mutants swap this).
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse, body?: unknown) => Promise<void>}
 */
export function createLegacySessionHandler({
  buildServer,
  sessions = new Map(),
  mode = "serve",
  transportFactory = (options) => new NodeStreamableHTTPServerTransport(options),
  sessionPrincipalKeyFn = sessionPrincipalKey,
}) {
  if (mode !== "serve" && mode !== "reject") {
    throw new Error(`Invalid legacy MCP transport mode: "${mode}". Use "serve" or "reject".`);
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

  async function openSession(identity) {
    const principalKey = sessionPrincipalKeyFn(identity);
    if (!principalKey) {
      throw new McpHttpClientError(403, "Session cannot be bound to this principal");
    }
    const transport = transportFactory({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => sessions.set(id, { transport, principalKey }),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = await buildServer({ era: "legacy" });
    await server.connect(transport);
    return transport;
  }

  return async function handleLegacy(req, res, body) {
    if (mode === "reject") {
      if (req.method === "GET" || req.method === "DELETE") {
        methodNotAllowed(res);
        return;
      }
      res.writeHead(400).end("Legacy MCP transport is disabled");
      return;
    }

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
  };
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
 *   - everything else — 401 without a resolved identity, 404 after auth.
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
 * @param {number} [deps.toolCount] Ignored; retained so existing call sites
 *   keep compiling. `/health` no longer exposes a tool count.
 * @param {(req: object, res: object, body?: unknown) => Promise<void>} deps.modernHandler
 * @param {(req: object, res: object, body?: unknown) => Promise<void>} deps.legacyHandler
 * @param {?{check: (key: string) => {allowed: boolean, retryAfterSec: number}}} [deps.rateLimiter]
 *   Optional rate limiter (see rate-limit.js). Omit/null to disable.
 * @param {(req: import("http").IncomingMessage) => string} [deps.clientKey]
 *   Maps a request to a rate-limit key (default: client IP).
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
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => Promise<void>}
 */
export function createMcpRequestHandler({
  checkAuth = () => true,
  authenticate = null,
  allowLocalOperator = false,
  protectedResource = null,
  resourceMetadataUrl,
  toolCount: _toolCount,
  modernHandler = null,
  legacyHandler = null,
  rateLimiter = null,
  clientKey = (req) => req.socket?.remoteAddress || "unknown",
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
}) {
  if (!modernHandler || !legacyHandler) {
    throw new Error("modernHandler and legacyHandler must be configured together for dual-era routing");
  }

  const writer = auditWriter === undefined
    ? createHttpAuditWriter({ sink: defaultHttpAuditSink })
    : auditWriter;

  function requestPath(req) {
    return String(req.url || "").split("?")[0];
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
    return runWithIdentity(req.mcpIdentity, fn, { surface: "network" });
  }

  return async function handle(req, res) {
    if (writer) attachHttpAudit(req, res, writer);
    const path = requestPath(req);

    if (isUnauthenticatedRoute(req.method, path)) {
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

    const isMcp = path === "/mcp" && ["POST", "GET", "DELETE"].includes(req.method);
    if (isMcp && rateLimiter) {
      // Rate limit BEFORE auth so repeated bad-token attempts are throttled too.
      const verdict = rateLimiter.check(clientKey(req));
      if (!verdict.allowed) {
        res.writeHead(429, { "Retry-After": String(verdict.retryAfterSec) }).end("Too Many Requests");
        return;
      }
    }

    if (!await gateAuth(req, res)) return;

    if (path === "/mcp") {
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

    if (path === "/mcp" && (req.method === "GET" || req.method === "DELETE")) {
      if (!req.headers["mcp-session-id"]) {
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

    if (req.method === "POST" && path === "/mcp") {
      if (!isJsonContentType(req.headers["content-type"])) {
        res.writeHead(415).end("Content-Type must be application/json");
        return;
      }
      let stage = "body-read";
      try {
        const body = await readJsonBody(req, maxBodyBytes);
        if (isJsonRpcBatch(body)) {
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
  };
}
