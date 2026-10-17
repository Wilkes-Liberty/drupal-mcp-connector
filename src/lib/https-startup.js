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
import { resolveAllowedHosts, resolveAllowedOrigins } from "./http-transport.js";
import { createHttpRateLimiters, resolveHttpRateLimitOptions } from "./rate-limit.js";

/**
 * `handlerOverrides` may only swap these predicate hooks. Auth, the audit
 * writer, and every other `createMcpRequestHandler` dep must be passed as
 * dedicated options so a spread cannot drop the #451 writer or unauthenticate
 * `/mcp` (DEV-866 review L1).
 */
export const ALLOWED_HANDLER_OVERRIDE_KEYS = Object.freeze([
  "originAllowedFn",
  "protocolVersionSupportedFn",
  "acceptOkFn",
  "isUnauthenticatedRouteFn",
  "sessionlessMethodRefusedFn",
  "isJsonRpcBatchFn",
  "sessionPrincipalKeyFn",
  "principalRateKeyFn",
  "hostAllowedFn",
]);

/**
 * Eval/test seams `src/index.js` must not pass. Checked by importing
 * {@link buildProductionHttpsOptions}, not by grepping the entry source.
 */
export const PRODUCTION_STARTUP_SEAM_KEYS = Object.freeze([
  "fetchFn",
  "auditWriter",
  "handlerOverrides",
  "wrapHandler",
  "wrapRequestHandler",
  "checkAuth",
  "authenticate",
  "allowLocalOperator",
  "resolveInboundAuthModeFn",
]);

/**
 * Seam keys present on a `startHttpsTransport` options object.
 *
 * @param {object|null|undefined} options
 * @returns {string[]}
 */
export function usedProductionSeamKeys(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return [...PRODUCTION_STARTUP_SEAM_KEYS];
  }
  return PRODUCTION_STARTUP_SEAM_KEYS.filter((key) => Object.hasOwn(options, key));
}

/**
 * HTTPS options the production entry passes. Import and inspect this
 * instead of a source-text "no hooks" pin.
 *
 * @param {object} [args]
 * @returns {object}
 */
export function buildProductionHttpsOptions({
  bindHost,
  port,
  allowHttp,
  allowUnauth,
  sharedToken,
  inboundCfg,
  tls,
  buildServer,
  listenLabel,
  legacyMode,
  rateLimiter,
  principalLimiter,
  trustedProxies,
  metrics,
} = {}) {
  return {
    bindHost,
    port,
    allowHttp,
    allowUnauth,
    sharedToken,
    inboundCfg,
    tls,
    buildServer,
    listenLabel,
    legacyMode,
    rateLimiter,
    principalLimiter,
    trustedProxies,
    metrics,
  };
}

const FORBIDDEN_HANDLER_OVERRIDE_KEYS = Object.freeze([
  "checkAuth",
  "authenticate",
  "allowLocalOperator",
  "auditWriter",
]);

/**
 * Reject `handlerOverrides` keys that are not predicate `*Fn` hooks or
 * `sessionPrincipalKeyFn`. Throws at construction, before listen.
 *
 * @param {object} [overrides]
 */
export function assertHandlerOverrides(overrides = {}) {
  if (overrides === null || overrides === undefined || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("handlerOverrides must be an object");
  }
  const allowed = new Set(ALLOWED_HANDLER_OVERRIDE_KEYS);
  for (const key of Object.keys(overrides)) {
    if (FORBIDDEN_HANDLER_OVERRIDE_KEYS.includes(key) || !allowed.has(key)) {
      throw new Error(
        `handlerOverrides.${key} is not allowed (only predicate *Fn hooks, sessionPrincipalKeyFn, and principalRateKeyFn)`,
      );
    }
  }
}

/**
 * Copy only allowlisted override keys that the caller actually set.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function pickHandlerOverrides(overrides = {}) {
  assertHandlerOverrides(overrides);
  const picked = {};
  if (overrides.originAllowedFn !== undefined) picked.originAllowedFn = overrides.originAllowedFn;
  if (overrides.protocolVersionSupportedFn !== undefined) {
    picked.protocolVersionSupportedFn = overrides.protocolVersionSupportedFn;
  }
  if (overrides.acceptOkFn !== undefined) picked.acceptOkFn = overrides.acceptOkFn;
  if (overrides.isUnauthenticatedRouteFn !== undefined) {
    picked.isUnauthenticatedRouteFn = overrides.isUnauthenticatedRouteFn;
  }
  if (overrides.sessionlessMethodRefusedFn !== undefined) {
    picked.sessionlessMethodRefusedFn = overrides.sessionlessMethodRefusedFn;
  }
  if (overrides.isJsonRpcBatchFn !== undefined) picked.isJsonRpcBatchFn = overrides.isJsonRpcBatchFn;
  if (overrides.sessionPrincipalKeyFn !== undefined) {
    picked.sessionPrincipalKeyFn = overrides.sessionPrincipalKeyFn;
  }
  if (overrides.principalRateKeyFn !== undefined) picked.principalRateKeyFn = overrides.principalRateKeyFn;
  if (overrides.hostAllowedFn !== undefined) picked.hostAllowedFn = overrides.hostAllowedFn;
  return picked;
}

/**
 * Startup refusal for a cleartext listener on a non-loopback bind host.
 *
 * @param {string} bindHost
 * @returns {string}
 */
export function plainHttpNonLoopbackReason(bindHost) {
  return `Plain HTTP binds loopback only; refusing to listen on ${bindHost} without TLS certificates.`;
}

/**
 * Last-resort fail-closed response when `onRequest` throws or rejects.
 * Does not dispatch. Once headers went out the socket is destroyed instead.
 *
 * @param {import("http").ServerResponse} res
 */
function failClosedRequest(res) {
  if (res.headersSent) {
    // A 500 can no longer be written. Close the socket so the client does
    // not wait for an end that never comes and the audit close hook fires.
    if (!res.writableEnded) res.destroy();
    return;
  }
  try {
    res.writeHead(500).end("Internal Server Error");
  } catch {
    // Response already gone.
  }
}

/**
 * Invoke the assembled request handler and convert a throw or rejection
 * into 500 fail-closed (DEV-866 review L2).
 *
 * @param {Function} onRequest
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
function invokeOnRequest(onRequest, req, res) {
  try {
    const result = onRequest(req, res);
    if (result && typeof result.then === "function") {
      result.catch(() => failClosedRequest(res));
    }
  } catch {
    failClosedRequest(res);
  }
}

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
      invokeOnRequest(onRequest, req, res);
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
    invokeOnRequest(onRequest, req, res);
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
 * @param {string} [options.legacyMode]
 * @param {?object} [options.rateLimiter] Per-address limiter (unauthenticated / failed-auth traffic).
 * @param {?object} [options.principalLimiter] Per-verified-principal limiter (DEV-860).
 * @param {readonly string[]} [options.trustedProxies] Peers allowed to set `X-Forwarded-For`.
 * @param {(req: import("http").IncomingMessage) => string} [options.clientKey]
 * @param {typeof fetch} [options.fetchFn] Eval/test seam; production omits this.
 * @param {{write: Function}|null} [options.auditWriter] Eval/test seam; production omits this.
 * @param {Function} [options.checkAuth] Eval/test seam; production omits this.
 * @param {Function|null} [options.authenticate] Eval/test seam; production omits this.
 * @param {boolean} [options.allowLocalOperator] Eval/test seam; production omits this.
 * @param {object} [options.handlerOverrides]
 *   Allowlisted predicate `*Fn` hooks plus `sessionPrincipalKeyFn` only.
 *   `checkAuth`, `authenticate`, `allowLocalOperator`, `auditWriter`, and
 *   unknown keys throw at construction.
 * @param {(handler: Function) => Function} [options.wrapHandler]
 * @param {(handler: Function, ctx: object) => Function} [options.wrapRequestHandler]
 *   Wraps the assembled `(req, res)` handler (eval mutants / taps).
 * @param {typeof resolveInboundAuthMode} [options.resolveInboundAuthModeFn]
 * @param {(code: number, reason?: string) => void} [options.exit]
 * @param {(msg: string) => void} [options.log]
 * @param {string} [options.listenLabel] Extra listen-line detail (tool/resource/prompt counts).
 * @param {string} [options.listenHost] Loopback-only override of the address used for `listen` (tests); any non-loopback value throws at construction.
 * @param {?{beginRequest: Function, finishRequest: Function}} [options.metrics] Ops metrics registry (DEV-863).
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
  legacyMode = "serve",
  rateLimiter = null,
  principalLimiter,
  trustedProxies = [],
  clientKey,
  fetchFn,
  auditWriter,
  checkAuth: checkAuthOption,
  authenticate: authenticateOption,
  allowLocalOperator: allowLocalOperatorOption,
  handlerOverrides = {},
  wrapHandler = (handler) => handler,
  wrapRequestHandler = (handler) => handler,
  resolveInboundAuthModeFn = resolveInboundAuthMode,
  exit = (code) => process.exit(code),
  log = (msg) => console.error(msg),
  listenLabel,
  listenHost,
  metrics = null,
} = {}) {
  const pickedOverrides = pickHandlerOverrides(handlerOverrides);
  // `listenHost` only narrows where the socket binds for tests; every
  // auth/TLS decision is made against `bindHost`, so it must never widen
  // exposure beyond loopback.
  if (listenHost !== undefined && !isLoopbackBind(listenHost)) {
    throw new Error(`listenHost must be a loopback address (got ${listenHost})`);
  }
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
  const hasTls = Boolean(tls?.certPath && tls?.keyPath);
  // Cleartext never leaves loopback, whatever the auth mode. `src/index.js`
  // already forces 127.0.0.1 without TLS; the extracted API enforces the
  // same boundary itself, before issuer discovery and before listen.
  if (!hasTls && !loopbackBind) {
    const reason = plainHttpNonLoopbackReason(bindHost);
    log(`[drupal-mcp-connector] FATAL: ${reason}`);
    exit(1, reason);
    return { started: false, inboundMode: { mode: "fatal", reason }, reason };
  }
  let checkAuth = () => true;
  let authenticate = null;
  let inboundIntrospect = null;
  let protectedResource = null;
  let resourceMetadataUrl;
  if (inboundMode.mode === "resource_server") {
    try {
      const inbound = await createInboundHttpsAuth({
        inboundCfg,
        ...(fetchFn ? { fetchFn } : {}),
      });
      authenticate = inbound.authenticate;
      inboundIntrospect = inbound.introspect;
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
  if (checkAuthOption !== undefined) checkAuth = checkAuthOption;
  if (authenticateOption !== undefined) authenticate = authenticateOption;
  const allowLocalOperator = allowLocalOperatorOption !== undefined
    ? allowLocalOperatorOption
    : loopbackBind && inboundMode.mode === "unauthenticated";

  const modernHandler = wrapHandler(toNodeHandler(modernMcpHandler, {
    onerror: () => reportMcpTransportStage("modern-adapter"),
  }));
  const { sessionPrincipalKeyFn, ...handlerFns } = pickedOverrides;
  const legacySessionHandler = createLegacySessionHandler({
    buildServer,
    mode: legacyMode,
    // Pass every explicitly supplied value (including null) so the
    // handler's construction-time type check runs instead of the default.
    ...(sessionPrincipalKeyFn !== undefined ? { sessionPrincipalKeyFn } : {}),
  });
  const legacyHandler = wrapHandler(legacySessionHandler);

  const requestHandler = wrapRequestHandler(createMcpRequestHandler({
    checkAuth,
    authenticate,
    ...(typeof inboundIntrospect === "function" ? { introspect: inboundIntrospect } : {}),
    protectedResource,
    resourceMetadataUrl,
    allowLocalOperator,
    modernHandler,
    legacyHandler,
    rateLimiter,
    ...(principalLimiter !== undefined ? { principalLimiter } : {}),
    trustedProxies,
    allowedOrigins: resolveAllowedOrigins({
      allowedOrigins: inboundCfg?.allowedOrigins,
      resource: inboundCfg?.resource,
      audience: inboundCfg?.audience,
    }),
    // DEV-861: Host allowlist from config/env plus the resource host; loopback
    // names are added when the process binds loopback.
    allowedHosts: resolveAllowedHosts({
      allowedHosts: inboundCfg?.allowedHosts,
      resource: inboundCfg?.resource,
      audience: inboundCfg?.audience,
      loopbackBind,
    }),
    ...(auditWriter !== undefined ? { auditWriter } : {}),
    ...(clientKey ? { clientKey } : {}),
    ...(metrics ? { metrics } : {}),
    ...handlerFns,
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
    nodeServer.listen(port, listenHost || bindHost, () => {
      nodeServer.removeListener("error", reject);
      resolve();
    });
  });
  const address = nodeServer.address();
  const proto = tls?.certPath && tls?.keyPath ? "https" : "http";
  const host = address.address === "::" ? "127.0.0.1" : address.address;
  // An IPv6 literal must be bracketed inside a URL (`http://[::1]:3443/mcp`).
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const url = `${proto}://${urlHost}:${address.port}/mcp`;
  const logHost = String(bindHost).includes(":") ? `[${bindHost}]` : bindHost;
  log(
    `[drupal-mcp-connector v${CLIENT_VERSION}] Listening on ${proto}://${logHost}:${address.port}/mcp` +
    (listenLabel ? `\n  ${listenLabel}` : ""),
  );

  return {
    started: true,
    inboundMode,
    server: nodeServer,
    url,
    resourceMetadataUrl,
    close: async () => {
      await modernMcpHandler.close?.();
      await legacySessionHandler.close?.();
      await new Promise((resolve) => {
        nodeServer.close(() => resolve());
        nodeServer.closeAllConnections?.();
      });
    },
  };
}

/**
 * Register SIGTERM/SIGINT handlers that close the HTTPS transport: the
 * modern handler, leftover 2025 session transports, and the Node server.
 *
 * @param {{close?: () => Promise<void>}|null|undefined} started
 * @param {object} [hooks]
 * @param {readonly string[]} [hooks.signals]
 * @param {(signal: string, listener: Function) => void} [hooks.on]
 * @param {(signal: string, listener: Function) => void} [hooks.off]
 * @param {(code: number) => void} [hooks.exit]
 * @returns {() => Promise<void>}
 */
export function installHttpsShutdown(started, {
  signals = ["SIGTERM", "SIGINT"],
  on = (signal, listener) => process.on(signal, listener),
  off = (signal, listener) => process.off(signal, listener),
  exit = (code) => process.exit(code),
} = {}) {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const signal of signals) off(signal, shutdown);
    try {
      await started?.close?.();
      exit(0);
    } catch {
      exit(1);
    }
  };
  for (const signal of signals) on(signal, shutdown);
  return shutdown;
}

/**
 * Build the address and principal limiters `src/index.js` attaches to `/mcp`
 * (DEV-860), plus the resolved values it logs. Either limiter is `null`
 * when its gate is off.
 *
 * @param {object} [options]
 * @param {boolean} [options.hasTls]
 * @param {boolean} [options.loopbackBind]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {() => number} [options.now]
 * @returns {{
 *   rateLimiter: ?object,
 *   principalLimiter: ?object,
 *   addressLimit: number,
 *   principalLimit: number,
 *   windowSec: number,
 * }}
 */
export function createStartupRateLimiters({
  hasTls,
  loopbackBind,
  env = process.env,
  now,
} = {}) {
  const opts = resolveHttpRateLimitOptions({ hasTls, loopbackBind, env });
  const { rateLimiter, principalLimiter } = createHttpRateLimiters({ ...opts, ...(now ? { now } : {}) });
  return {
    rateLimiter,
    principalLimiter,
    addressLimit: opts.addressLimit,
    principalLimit: opts.principalLimit,
    windowSec: opts.windowSec,
  };
}
