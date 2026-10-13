/**
 * HTTPS transport startup used by `src/index.js`.
 *
 * Extracted so evals and tests can drive the same inbound-mode decision,
 * resource-server wiring, handler assembly, and listen/exit path the
 * process uses — without importing the CLI entry (which would start
 * stdio). Optional hooks are unused in production.
 */

import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { CLIENT_VERSION } from "./config.js";
import {
  createInboundHttpsAuth,
  isLoopbackBind,
  resolveInboundAuthMode,
} from "./http-auth.js";
import { createLegacySessionHandler, createMcpRequestHandler } from "./http-handler.js";
import { resolveAllowedOrigins } from "./http-transport.js";
import { createRateLimiter } from "./rate-limit.js";

/**
 * Security headers applied to every HTTPS/HTTP response in production.
 *
 * @param {import("http").ServerResponse} res
 */
export function applyHttpsSecurityHeaders(res) {
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
}

/**
 * @param {object} options
 * @param {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => void} options.onRequest
 * @param {{certPath?: string, keyPath?: string}|null} [options.tls]
 * @param {boolean} [options.allowHttp]
 * @param {(code: number, reason: string) => void} options.exit
 * @param {(msg: string) => void} options.log
 * @returns {import("http").Server|null}
 */
function createNodeServer({ onRequest, tls, allowHttp, exit, log }) {
  if (tls?.certPath && tls?.keyPath) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- TLS cert/key path comes from operator-controlled config, not user input
    const cert = readFileSync(tls.certPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- TLS cert/key path comes from operator-controlled config, not user input
    const key = readFileSync(tls.keyPath);
    return createHttpsServer({ cert, key }, (req, res) => {
      applyHttpsSecurityHeaders(res);
      onRequest(req, res);
    });
  }

  if (!allowHttp) {
    log(
      "[drupal-mcp-connector] FATAL: HTTP transport requires TLS certificates.\n" +
      "  Set TLS_CERT_PATH and TLS_KEY_PATH, or MCP_ALLOW_HTTP=1 for localhost-only dev.\n" +
      "  See docs/getting-started.md for TLS setup instructions.",
    );
    exit(1, "HTTP transport requires TLS certificates.");
    return null;
  }

  log(
    "[drupal-mcp-connector] WARNING: Running plain HTTP (MCP_ALLOW_HTTP=1). " +
    "ONLY acceptable for local development. Never expose this to the internet.",
  );
  return createHttpServer((req, res) => {
    applyHttpsSecurityHeaders(res);
    onRequest(req, res);
  });
}

/**
 * Start the HTTPS (or opted-in loopback HTTP) MCP transport the way
 * `src/index.js` does. Optional hooks are the eval/test seam: production
 * passes none of them.
 *
 * @param {object} options
 * @param {string} options.bindHost
 * @param {number} options.port
 * @param {boolean} [options.allowHttp]
 * @param {boolean} [options.allowUnauth]
 * @param {string} [options.sharedToken]
 * @param {object} options.inboundCfg
 * @param {{certPath?: string, keyPath?: string}|null} [options.tls]
 * @param {Function} options.buildServer
 * @param {number} options.toolCount
 * @param {string} [options.legacyMode]
 * @param {?object} [options.rateLimiter]
 * @param {typeof fetch} [options.fetchFn]
 * @param {{write: Function}|null} [options.auditWriter]
 * @param {object} [options.handlerOverrides] Extra `createMcpRequestHandler` deps.
 * @param {(handler: Function) => Function} [options.wrapHandler]
 * @param {(handler: Function, ctx: object) => Function} [options.wrapRequestHandler]
 *   Wraps the assembled `(req, res)` handler (eval mutants / taps).
 * @param {typeof resolveInboundAuthMode} [options.resolveInboundAuthModeFn]
 * @param {(code: number, reason?: string) => void} [options.exit]
 * @param {(msg: string) => void} [options.log]
 * @param {string} [options.listenLabel] Extra listen-line detail (tool/resource/prompt counts).
 * @param {string} [options.listenHost] Override the bind address used for `listen` only.
 * @returns {Promise<{
 *   started: boolean,
 *   inboundMode: {mode: string, reason?: string},
 *   reason?: string,
 *   server?: import("http").Server,
 *   url?: string,
 *   resourceMetadataUrl?: string,
 *   close?: () => Promise<void>,
 * }>}
 */
export async function startHttpsTransport({
  bindHost,
  port,
  allowHttp = false,
  allowUnauth = false,
  sharedToken = "",
  inboundCfg,
  tls = null,
  buildServer,
  toolCount,
  legacyMode = "serve",
  rateLimiter = null,
  fetchFn,
  auditWriter,
  handlerOverrides = {},
  wrapHandler = (handler) => handler,
  wrapRequestHandler = (handler) => handler,
  resolveInboundAuthModeFn = resolveInboundAuthMode,
  exit = (code) => process.exit(code),
  log = (msg) => console.error(msg),
  listenLabel,
  listenHost,
} = {}) {
  const inboundMode = resolveInboundAuthModeFn({
    bindHost,
    allowUnauth,
    sharedToken,
    resourceServer: inboundCfg,
  });
  if (inboundMode.mode === "fatal") {
    log(`[drupal-mcp-connector] FATAL: ${inboundMode.reason}`);
    exit(1, inboundMode.reason);
    return { started: false, inboundMode, reason: inboundMode.reason };
  }

  const loopbackBind = isLoopbackBind(bindHost);
  let checkAuth = () => true;
  let authenticate = null;
  let protectedResource = null;
  let resourceMetadataUrl;
  if (inboundMode.mode === "resource_server") {
    try {
      const inbound = await createInboundHttpsAuth({
        inboundCfg,
        ...(fetchFn ? { fetchFn } : {}),
      });
      authenticate = inbound.authenticate;
      protectedResource = inbound.protectedResource;
      resourceMetadataUrl = inbound.resourceMetadataUrl;
      checkAuth = () => false;
      log(
        `[drupal-mcp-connector] Inbound OAuth resource server: issuer ${inboundCfg.issuer} (introspect every call)`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      log(
        "[drupal-mcp-connector] FATAL: inbound issuer discovery failed.\n" +
        `  ${reason}`,
      );
      exit(1, reason);
      return { started: false, inboundMode: { mode: "fatal", reason }, reason };
    }
  } else if (inboundMode.mode === "unauthenticated" && !allowUnauth) {
    log(
      "[drupal-mcp-connector] WARNING: the /mcp endpoint is UNAUTHENTICATED. " +
      "Acceptable only on loopback or behind a trusted auth boundary.",
    );
  }

  const reportMcpTransportStage = (stage) => {
    log(`[drupal-mcp-connector] MCP ${stage} failed.`);
  };
  const modernMcpHandler = createMcpHandler(buildServer, {
    legacy: "reject",
    onerror: () => reportMcpTransportStage("modern-protocol"),
  });
  const modernHandler = wrapHandler(toNodeHandler(modernMcpHandler, {
    onerror: () => reportMcpTransportStage("modern-adapter"),
  }));
  const legacyHandler = wrapHandler(createLegacySessionHandler({
    buildServer,
    mode: legacyMode,
    sessionPrincipalKeyFn: handlerOverrides.sessionPrincipalKeyFn,
  }));

  const requestHandler = wrapRequestHandler(createMcpRequestHandler({
    checkAuth,
    authenticate,
    protectedResource,
    resourceMetadataUrl,
    allowLocalOperator: loopbackBind && inboundMode.mode === "unauthenticated",
    modernHandler,
    legacyHandler,
    toolCount,
    rateLimiter,
    allowedOrigins: resolveAllowedOrigins({
      allowedOrigins: inboundCfg?.allowedOrigins,
      resource: inboundCfg?.resource,
      audience: inboundCfg?.audience,
    }),
    ...(auditWriter !== undefined ? { auditWriter } : {}),
    ...handlerOverrides,
  }), {
    modernHandler,
    legacyHandler,
    resourceMetadataUrl,
    authenticate,
  });

  const nodeServer = createNodeServer({
    onRequest: requestHandler,
    tls,
    allowHttp,
    exit,
    log,
  });
  if (!nodeServer) {
    return { started: false, inboundMode, reason: "HTTP transport requires TLS certificates." };
  }

  await new Promise((resolve, reject) => {
    nodeServer.once("error", reject);
    nodeServer.listen(port, listenHost || bindHost, () => resolve());
  });
  const address = nodeServer.address();
  const proto = tls?.certPath && tls?.keyPath ? "https" : "http";
  const host = address.address === "::" ? "127.0.0.1" : address.address;
  const url = `${proto}://${host}:${address.port}/mcp`;
  log(
    `[drupal-mcp-connector v${CLIENT_VERSION}] Listening on ${proto}://${bindHost}:${address.port}/mcp\n` +
    `  ${listenLabel || `${toolCount} tools`}`,
  );

  return {
    started: true,
    inboundMode,
    server: nodeServer,
    url,
    resourceMetadataUrl,
    close: async () => {
      await modernMcpHandler.close?.();
      await new Promise((resolve) => {
        nodeServer.close(() => resolve());
        nodeServer.closeAllConnections?.();
      });
    },
  };
}

/**
 * Build the rate limiter `src/index.js` attaches to `/mcp`.
 *
 * @param {object} options
 * @param {boolean} options.hasTls
 * @param {boolean} options.loopbackBind
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {() => number} [options.now]
 * @returns {?{check: Function}}
 */
export function createStartupRateLimiter({
  hasTls,
  loopbackBind,
  env = process.env,
  now,
} = {}) {
  const rateWindowSec = Number(env.MCP_RATE_WINDOW_SEC || 60);
  const rateLimitEnv = env.MCP_RATE_LIMIT;
  const rateLimitDefault = (hasTls && !loopbackBind) ? 120 : 0;
  const rateLimit = rateLimitEnv === undefined || rateLimitEnv === ""
    ? rateLimitDefault
    : Number(rateLimitEnv);
  if (!(rateLimit > 0)) return null;
  return createRateLimiter({
    limit: rateLimit,
    windowMs: rateWindowSec * 1000,
    ...(now ? { now } : {}),
  });
}
