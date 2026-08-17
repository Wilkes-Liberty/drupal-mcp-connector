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
import { formatWwwAuthenticate } from "./http-auth.js";

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
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse, body?: unknown) => Promise<void>}
 */
export function createLegacySessionHandler({
  buildServer,
  sessions = new Map(),
  mode = "serve",
  transportFactory = (options) => new NodeStreamableHTTPServerTransport(options),
}) {
  if (mode !== "serve" && mode !== "reject") {
    throw new Error(`Invalid legacy MCP transport mode: "${mode}". Use "serve" or "reject".`);
  }

  async function openSession() {
    const transport = transportFactory({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => sessions.set(id, transport),
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
      res.writeHead(400).end("Legacy MCP transport is disabled");
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.writeHead(404).end("Unknown MCP-Session-Id");
        return;
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      res.writeHead(400).end("MCP-Session-Id is required for legacy session requests");
      return;
    }

    const transport = await openSession();
    await transport.handleRequest(req, res, body);
  };
}

/**
 * Build the `(req, res)` handler for the MCP HTTP endpoint.
 *
 * Routes:
 *   - `POST /mcp` — rate- and bearer-gated, bounded/body-parsed once, then
 *     classified into exactly one modern-stateless or legacy-sessionful arm.
 *   - `GET|DELETE /mcp` — rate- and bearer-gated legacy session operations.
 *   - `GET /health` — unauthenticated liveness probe (`{status, tools}`).
 *   - everything else — 404.
 *
 * @param {object} deps
 * @param {(authHeader: any) => boolean} [deps.checkAuth] Shared-bearer predicate (loopback).
 * @param {(req: import("http").IncomingMessage) => Promise<object>} [deps.authenticate]
 *   Resource-server authenticator. When set, it replaces `checkAuth`.
 * @param {object|null} [deps.protectedResource] RFC 9728 metadata served unauthenticated.
 * @param {number} deps.toolCount Tool count reported by /health.
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
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => Promise<void>}
 */
export function createMcpRequestHandler({
  checkAuth = () => true,
  authenticate = null,
  protectedResource = null,
  toolCount,
  modernHandler = null,
  legacyHandler = null,
  rateLimiter = null,
  clientKey = (req) => req.socket?.remoteAddress || "unknown",
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  toWebRequestFn = toWebRequest,
  isLegacyRequestFn = isLegacyRequest,
  onError = defaultOnError,
}) {
  if (!modernHandler || !legacyHandler) {
    throw new Error("modernHandler and legacyHandler must be configured together for dual-era routing");
  }

  function requestPath(req) {
    return String(req.url || "").split("?")[0];
  }

  async function gateAuth(req, res) {
    if (authenticate) {
      let result;
      try {
        result = await authenticate(req);
      } catch {
        res.writeHead(401, {
          "WWW-Authenticate": formatWwwAuthenticate({
            error: "invalid_token",
            errorDescription: "Token validation failed",
          }),
        }).end("Unauthorized");
        return false;
      }
      if (!result.ok) {
        res.writeHead(result.status, result.headers).end(result.body);
        return false;
      }
      req.mcpIdentity = result.identity;
      return true;
    }
    if (!checkAuth(req.headers["authorization"])) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
      return false;
    }
    return true;
  }

  return async function handle(req, res) {
    const path = requestPath(req);
    if (
      req.method === "GET"
      && (path === "/.well-known/oauth-protected-resource"
        || path.startsWith("/.well-known/oauth-protected-resource/"))
    ) {
      if (!protectedResource) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(protectedResource));
      return;
    }

    if (req.url === "/mcp" && ["POST", "GET", "DELETE"].includes(req.method)) {
      // Rate limit BEFORE auth so repeated bad-token attempts are throttled too.
      if (rateLimiter) {
        const verdict = rateLimiter.check(clientKey(req));
        if (!verdict.allowed) {
          res.writeHead(429, { "Retry-After": String(verdict.retryAfterSec) }).end("Too Many Requests");
          return;
        }
      }
      // Auth gate: only the /mcp endpoint requires a token; /health and
      // protected-resource metadata stay open.
      if (!await gateAuth(req, res)) return;
    }

    if (req.url === "/mcp" && (req.method === "GET" || req.method === "DELETE")) {
      try {
        await legacyHandler(req, res);
      } catch (error) {
        respondAfterFailure(res, error, onError, "legacy-dispatch");
      }
      return;
    }

    if (req.method === "POST" && req.url === "/mcp") {
      if (!isJsonContentType(req.headers["content-type"])) {
        res.writeHead(415).end("Content-Type must be application/json");
        return;
      }
      let stage = "body-read";
      try {
        const body = await readJsonBody(req, maxBodyBytes);
        stage = "request-conversion";
        const request = await toWebRequestFn(req, body);
        stage = "classification";
        const legacy = await isLegacyRequestFn(request, body);
        const selectedHandler = legacy ? legacyHandler : modernHandler;
        stage = legacy ? "legacy-dispatch" : "modern-dispatch";
        await selectedHandler(req, res, body);
      } catch (error) {
        respondAfterFailure(res, error, onError, stage);
      }
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: "ok", tools: toolCount }));
      return;
    }

    res.writeHead(404).end("Not found");
  };
}
