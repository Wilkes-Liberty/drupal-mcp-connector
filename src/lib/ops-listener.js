/**
 * Mesh-only HTTP listener for GET /ready and GET /metrics (DEV-863).
 *
 * Disabled unless `MCP_OPS_LISTEN` or `ops.listen` is set. Binds loopback
 * or Tailscale only. The public MCP listener never serves these paths.
 * This listener has no authentication of its own.
 */

import { createServer as createHttpServer } from "node:http";
import { CLIENT_VERSION } from "./config.js";
import { isOpsBindAllowed, opsBindRefusedReason, resolveOpsListen } from "./ops-bind.js";
import { createReadyChecker, readyBody } from "./ops-ready.js";

/** Paths that exist only on the ops listener. */
export const OPS_PATHS = Object.freeze(["/ready", "/metrics"]);

/**
 * Whether `path` is an ops-only route (`/ready`, `/metrics`).
 *
 * @param {unknown} path
 * @returns {boolean}
 */
export function isOpsPath(path) {
  const raw = String(path || "").split("?")[0];
  return raw === "/ready" || raw === "/metrics";
}

/**
 * @param {unknown} url
 * @returns {string}
 */
function requestPath(url) {
  return String(url || "").split("?")[0];
}

/**
 * Build the `(req, res)` handler for the ops listener.
 *
 * @param {object} options
 * @param {{render: () => string}} options.metrics
 * @param {() => Promise<{ok: boolean, failed: string[]}>} options.checkReady
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => Promise<void>}
 */
export function createOpsRequestHandler({ metrics, checkReady }) {
  return async function handleOps(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    const path = requestPath(req.url);
    if (req.method === "GET" && path === "/ready") {
      const result = await checkReady();
      const body = readyBody(result);
      res.writeHead(result.ok ? 200 : 503, { "Content-Type": "application/json" })
        .end(JSON.stringify(body));
      return;
    }
    if (req.method === "GET" && path === "/metrics") {
      const text = metrics.render();
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" })
        .end(text);
      return;
    }
    res.writeHead(404).end("Not found");
  };
}

/**
 * Start the mesh-only ops listener. No-op when the spec is unset.
 * Fatal (exit 1, no listen) on a public / non-mesh bind.
 *
 * @param {object} options
 * @param {object} [options.resolved] Result of {@link resolveOpsListen}.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.config]
 * @param {{render: () => string}} options.metrics
 * @param {object} [options.readiness]
 * @param {(code: number, reason?: string) => void} [options.exit]
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{
 *   started: boolean,
 *   reason?: string,
 *   server?: import("http").Server,
 *   url?: string,
 *   close?: () => Promise<void>,
 * }>}
 */
export async function startOpsListener({
  resolved,
  env = process.env,
  config = {},
  metrics,
  readiness = {},
  exit = (code) => process.exit(code),
  log = (msg) => console.error(msg),
} = {}) {
  const listen = resolved || resolveOpsListen({ env, config });
  if (!listen.enabled && !listen.fatal) {
    return { started: false };
  }
  if (listen.fatal || !listen.enabled) {
    const reason = listen.reason || opsBindRefusedReason(String(listen.host || ""));
    log(`[drupal-mcp-connector] FATAL: ${reason}`);
    exit(1, reason);
    return { started: false, reason };
  }
  if (!isOpsBindAllowed(listen.host)) {
    const reason = opsBindRefusedReason(listen.host);
    log(`[drupal-mcp-connector] FATAL: ${reason}`);
    exit(1, reason);
    return { started: false, reason };
  }

  const checkReady = createReadyChecker(readiness);
  const onRequest = createOpsRequestHandler({ metrics, checkReady });
  const server = createHttpServer((req, res) => {
    Promise.resolve(onRequest(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500).end("Internal Server Error");
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listen.port, listen.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "ops listen failed";
    log(`[drupal-mcp-connector] FATAL: ${reason}`);
    exit(1, reason);
    return { started: false, reason };
  }

  const address = server.address();
  const host = address.address === "::" ? "127.0.0.1" : address.address;
  const urlHost = String(host).includes(":") ? `[${host}]` : host;
  const url = `http://${urlHost}:${address.port}`;
  const logHost = String(listen.host).includes(":") ? `[${listen.host}]` : listen.host;
  log(
    `[drupal-mcp-connector v${CLIENT_VERSION}] Ops listener on http://${logHost}:${address.port} (/ready, /metrics)`,
  );

  return {
    started: true,
    server,
    url,
    close: async () => {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
