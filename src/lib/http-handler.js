/**
 * HTTP request handler for the Streamable-HTTP MCP transport.
 *
 * Extracted from index.js so the routing/auth/health/404 behavior is unit
 * testable without standing up a real server or the MCP SDK. The entry point
 * wires the concrete dependencies (bearer check, session map, session factory);
 * tests inject stubs.
 */

/**
 * Build the `(req, res)` handler for the MCP HTTP endpoint.
 *
 * Routes:
 *   - `POST /mcp`  — bearer-gated; reuses a session by `Mcp-Session-Id` or opens
 *     a new one, then delegates to the transport's `handleRequest`.
 *   - `GET /mcp`   — bearer-gated; requires a known session, else 400.
 *   - `GET /health`— unauthenticated liveness probe (`{status, tools}`).
 *   - everything else — 404.
 *
 * @param {object} deps
 * @param {(authHeader: any) => boolean} deps.checkAuth Bearer predicate (see http-auth.js).
 * @param {Map<string, {handleRequest: Function, sessionId?: string}>} deps.sessions Session id → transport.
 * @param {() => Promise<{handleRequest: Function}>} deps.openSession Create+connect a new transport.
 * @param {number} deps.toolCount Tool count reported by /health.
 * @param {?{check: (key: string) => {allowed: boolean, retryAfterSec: number}}} [deps.rateLimiter]
 *   Optional rate limiter (see rate-limit.js). Omit/null to disable.
 * @param {(req: import("http").IncomingMessage) => string} [deps.clientKey]
 *   Maps a request to a rate-limit key (default: client IP).
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => Promise<void>}
 */
export function createMcpRequestHandler({
  checkAuth, sessions, openSession, toolCount,
  rateLimiter = null,
  clientKey = (req) => req.socket?.remoteAddress || "unknown",
}) {
  return async function handle(req, res) {
    if (req.url === "/mcp" && (req.method === "POST" || req.method === "GET")) {
      // Rate limit BEFORE auth so repeated bad-token attempts are throttled too.
      if (rateLimiter) {
        const verdict = rateLimiter.check(clientKey(req));
        if (!verdict.allowed) {
          res.writeHead(429, { "Retry-After": String(verdict.retryAfterSec) }).end("Too Many Requests");
          return;
        }
      }
      // Auth gate: only the /mcp endpoint requires a token; /health stays open.
      if (!checkAuth(req.headers["authorization"])) {
        res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
        return;
      }
    }

    if (req.method === "POST" && req.url === "/mcp") {
      const sessionId = req.headers["mcp-session-id"];
      const transport = (sessionId && sessions.get(sessionId)) || (await openSession());
      await transport.handleRequest(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/mcp") {
      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400).end("Missing or unknown MCP-Session-Id");
        return;
      }
      await sessions.get(sessionId).handleRequest(req, res);
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
