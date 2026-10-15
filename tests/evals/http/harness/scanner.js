/**
 * X1 scanner (DEV-866 increment 3).
 *
 * Every HTTP route and tool in the live inventory — `allDefinitions` plus
 * the transport route tables, never a hand-copied list — must reach
 * dispatch only after authn and authz. Public routes stay public.
 *
 * Production eval seams are pinned by importing `buildProductionHttpsOptions`
 * (the residual asked for an import / runtime-spy pin, not source-text).
 */

import { httpsStartup, httpHandler, principal, toolScopes, tools } from "./connector.js";
import { liveRoutes, liveTools } from "./coverage.js";
import {
  assessorGet,
  healthGet,
  modernPost,
  resourceMetadataGet,
  sessionRequest,
  usageGet,
} from "./requests.js";

/** Synthetic name used only by the X1-open-tools mutant. */
export const SCANNER_OPEN_TOOLS = "X1-open-tools";
export const SCANNER_PUBLIC_ALL = "X1-public-all";
export const SCANNER_SEAMS = "X1-seams";

/**
 * @param {string} route
 * @returns {{method: string, path: string}}
 */
export function splitRoute(route) {
  const space = route.indexOf(" ");
  return { method: route.slice(0, space), path: route.slice(space + 1) };
}

/**
 * Request builder for a live route name (`METHOD /path`).
 *
 * @param {string} route
 * @returns {{method: string, headers: object, body?: string, path?: string}}
 */
export function requestForRoute(route) {
  const { method, path } = splitRoute(route);
  if (path === "/health") return healthGet();
  if (path.startsWith("/.well-known/")) return resourceMetadataGet(path);
  if (path === "/usage") return usageGet();
  if (path === "/assessor") return assessorGet();
  if (method === "POST") return modernPost("tools/list");
  return sessionRequest(method);
}

/**
 * @param {string|null} mutant
 * @returns {object}
 */
export function productionOptionsForScan(mutant) {
  const options = httpsStartup.buildProductionHttpsOptions({
    bindHost: "127.0.0.1",
    port: 0,
    allowHttp: true,
    allowUnauth: false,
    sharedToken: "",
    inboundCfg: { issuer: "https://issuer.example", audience: "https://mcp.example/mcp" },
    tls: null,
    buildServer: () => ({}),
    listenLabel: "x1",
    legacyMode: "serve",
    rateLimiter: null,
    principalLimiter: null,
    trustedProxies: [],
    metrics: null,
  });
  if (mutant === SCANNER_SEAMS) return { ...options, checkAuth: () => true };
  return options;
}

/**
 * Counted assertions: production options omit eval seams.
 *
 * @param {object} h
 * @param {(h: object, label: string, actual: unknown, expected: unknown) => void} expectEqual
 */
export function assertProductionSeams(h, expectEqual) {
  const used = httpsStartup.usedProductionSeamKeys(productionOptionsForScan(h.mutant));
  expectEqual(h, "X1: production startup omits eval seams", used, []);
}

/**
 * Counted assertions: every live tool is refused without a network identity
 * and is present in the hosted scope table.
 *
 * @param {object} h
 * @param {(h: object, label: string, actual: unknown, expected: unknown) => void} expectEqual
 */
export function assertLiveToolsAuthz(h, expectEqual) {
  const surface = h.mutant === SCANNER_OPEN_TOOLS ? null : "network";
  principal.runWithIdentity(null, () => {
    for (const tool of liveTools()) {
      expectEqual(
        h,
        `X1: tool ${tool} denied without identity`,
        principal.principalMayUseTool(tool, null, [], null),
        false,
      );
    }
  }, { surface });

  try {
    toolScopes.assertHostedToolScopeTable(tools.allDefinitions);
    expectEqual(h, "X1: hosted scope table covers every live tool", true, true);
  } catch (error) {
    expectEqual(h, "X1: hosted scope table covers every live tool", error instanceof Error ? error.message : error, "");
  }
}

/**
 * Runtime probe: each live route is public or 401-before-dispatch.
 *
 * @param {object} h
 * @param {(h: object, label: string, res: object, expected?: object) => void} expectRefused
 * @param {(h: object, label: string, res: object, expected?: object) => void} expectAllowed
 * @param {(h: object, label: string) => void} expectHandlerUnreached
 */
export async function assertLiveRoutesAuthn(h, expectRefused, expectAllowed, expectHandlerUnreached) {
  for (const route of liveRoutes()) {
    const { method, path } = splitRoute(route);
    const edge = (path === "/usage" || path === "/assessor") && h.edgeUrl
      ? { base: h.edgeUrl }
      : {};
    const res = await h.send(requestForRoute(route), edge);
    const label = `X1: ${route} unauthenticated`;
    // Expected public/auth split is always the live table, never the mutant.
    if (httpHandler.isUnauthenticatedRoute(method, path)) {
      expectAllowed(h, `X1: ${route} public`, res);
    } else {
      expectRefused(h, label, res);
      expectHandlerUnreached(h, label);
    }
  }
}
