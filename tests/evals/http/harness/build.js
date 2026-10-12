/**
 * Compose the connector's HTTP request handler the way production does in
 * hosted (resource-server) mode, over fakes, behind a loopback server.
 *
 *   inbound auth : real `createInboundHttpsAuth` against the stub issuer
 *   handler      : real `createMcpRequestHandler` with the real rate limiter
 *   dispatch     : real SDK modern handler and real legacy session handler
 *   tools        : a stand-in surface (see below) over the fake upstream
 *
 * The tool surface is a stand-in: it applies the connector's own
 * `filterToolsByPrincipal` and `resolveGrantedSites` against an explicit grant
 * table, then reads the fake upstream. It does not run `dispatch.js` or
 * `drupal-fetch.js` (later increments).
 *
 * Mutants in this increment are dependency swaps at build time. They live
 * here, in `tests/`, and `src/` has no switch.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { installFakeClock } from "./clock.js";
import { httpAuth, httpHandler, mcpServer, principal, rateLimit } from "./connector.js";
import { createCounters } from "./counters.js";
import { createFakeDrupal } from "./fake-drupal.js";
import { createStubIssuer } from "./stub-issuer.js";
import { createTap } from "./taps.js";

/** Transport-required scope for the hosted configuration (fixture value). */
export const REQUIRED_SCOPES = ["mcp_connect"];

/** Fixture per-source limit, high enough that no case reaches it. Not a recommendation. */
const FIXTURE_RATE_LIMIT = 1000;

const TENANTS = [
  { tenant: "A", site: "site-a", clientId: "client-a" },
  { tenant: "B", site: "site-b", clientId: "client-b" },
];

const TOOL_DEFINITIONS = [
  { name: "drupal_list_nodes", description: "List nodes (read).", inputSchema: { type: "object", properties: {} } },
  { name: "drupal_create_node", description: "Create a node (write).", inputSchema: { type: "object", properties: {} } },
];

/**
 * Dependency-swap mutants: each removes exactly one guard from the handler's
 * dependencies. Keyed by the case id whose mutant it is.
 */
/**
 * Pre-DEV-845 inbound-mode decision: allowUnauth wins on any bind host.
 * Used only as the T1n mutant (dependency swap in this file).
 *
 * @param {object} options
 * @returns {{mode: string, reason?: string}}
 */
function failOpenInboundAuthMode({
  bindHost,
  allowUnauth = false,
  sharedToken = "",
  resourceServer = null,
}) {
  const isLoopback = bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";
  const hasRs = Boolean(resourceServer?.issuer && resourceServer?.audience);
  if (hasRs) return { mode: "resource_server" };
  if (allowUnauth) return { mode: "unauthenticated" };
  if (isLoopback) return sharedToken ? { mode: "shared_bearer" } : { mode: "unauthenticated" };
  return { mode: "fatal", reason: "Network-facing HTTPS requires an inbound OAuth resource server." };
}

/**
 * Pre-DEV-848 grant resolution: no table and no sites claim falls through
 * to every configured site. Used only as the T4b mutant (dependency swap).
 *
 * @param {object|null} identity
 * @param {Array<{_name: string}>} siteList
 * @param {object|null} grantTable
 * @returns {Array<object>}
 */
function fallThroughGrantedSites(identity, siteList, grantTable) {
  if (identity == null || identity.localOperator === true) return [...siteList];
  const names = siteList.map((site) => site._name);
  const known = new Set(names);
  let allowed;
  if (grantTable) {
    const listed = identity.clientId
      ? new Map(Object.entries(grantTable)).get(identity.clientId)
      : undefined;
    allowed = Array.isArray(listed) ? listed.map(String).filter((name) => known.has(name)) : [];
  } else if (Array.isArray(identity.sites)) {
    allowed = identity.sites.map(String).filter((name) => known.has(name));
  } else {
    allowed = [...names];
  }
  const entitled = new Set(allowed);
  return siteList.filter((site) => entitled.has(site._name));
}

/** T4 mutant: ignore grants and entitle every configured site. */
function allSitesGranted(_identity, siteList) {
  return [...siteList];
}

const MUTANTS = {
  // T1: drop the resource-server authenticator and allow a null principal
  // (the DEV-845 guard). Every request now dispatches under local operator.
  T1: () => ({ authenticate: null, checkAuth: () => true, allowLocalOperator: true }),
  // T1n: restore the pre-DEV-845 startup decision (allow-unauthenticated
  // on a non-loopback bind is not fatal).
  T1n: () => ({ resolveInboundAuthMode: failOpenInboundAuthMode }),
  // T4: ignore the grant table so a site-A grant also reaches B.
  T4: () => ({ resolveGrantedSites: allSitesGranted }),
  // T4b: restore the pre-DEV-848 fall-through (no grant, no sites claim → all sites).
  T4b: () => ({ resolveGrantedSites: fallThroughGrantedSites }),
  // T7: an authenticator that rejects everything (the over-blocking check).
  T7: () => ({
    authenticate: async () => httpAuth.denyAuth(401, {
      error: "invalid_token",
      errorDescription: "Token validation failed",
    }),
  }),
};

/**
 * Inbound-mode resolver for T1n. The green run uses the real function; the
 * mutant run uses the fail-open swap from {@link MUTANTS}.
 *
 * @param {object} options
 * @param {string|null} [mutant]
 * @returns {{mode: string, reason?: string}}
 */
export function inboundAuthModeForEval(options, mutant = null) {
  const swap = mutant && MUTANTS[mutant] ? MUTANTS[mutant]() : {};
  const resolve = swap.resolveInboundAuthMode ?? httpAuth.resolveInboundAuthMode;
  return resolve(options);
}

/** @returns {string[]} case ids that have a dependency-swap mutant */
export const mutantIds = () => Object.keys(MUTANTS);

function assertNoAmbientCredentials() {
  const ambient = Object.keys(process.env).filter((key) => /^(DRUPAL_|MCP_)/.test(key));
  if (ambient.length) {
    throw new Error(`Ambient connector variables are set (${ambient.join(", ")}). Run via "npm run eval:http".`);
  }
}

/**
 * @param {{mutant?: string|null, grants?: object|null}} [options] Case id of the dependency-swap mutant, or null for the real build. `grants: null` is T4b (no table).
 * @returns {Promise<object>} harness handle
 */
export async function buildHarness({ mutant = null, grants: grantsOption } = {}) {
  assertNoAmbientCredentials();
  if (mutant !== null && !MUTANTS[mutant]) throw new Error(`Unknown mutant "${mutant}".`);

  const clock = installFakeClock();
  const counters = createCounters();
  const tap = createTap();
  const issuer = await createStubIssuer();
  const fake = await createFakeDrupal(TENANTS);

  const sites = TENANTS.map(({ site }) => ({
    _name: site,
    baseUrl: fake.baseUrl(site),
    security: { preset: "development" },
  }));
  const defaultGrants = Object.fromEntries(TENANTS.map(({ clientId, site }) => [clientId, [site]]));
  const grants = grantsOption === undefined ? defaultGrants : grantsOption;
  const swap = mutant && MUTANTS[mutant] ? MUTANTS[mutant]() : {};
  const resolveGrantedSites = swap.resolveGrantedSites ?? principal.resolveGrantedSites;

  const inboundCfg = {
    issuer: issuer.issuer,
    audience: issuer.audience,
    resource: issuer.audience,
    requiredScopes: REQUIRED_SCOPES,
    revocationFile: "",
    introspectionUrl: issuer.introspectionUrl,
    introspectionClientId: "eval-rs",
    introspectionClientSecret: "eval-rs-secret",
  };
  const inbound = await httpAuth.createInboundHttpsAuth({ inboundCfg, fetchFn: issuer.fetchFn });

  const surface = {
    serverInfo: { name: "eval-http-connector", version: "0" },
    tools: {
      definitions: TOOL_DEFINITIONS,
      list: async () => principal.filterToolsByPrincipal(
        TOOL_DEFINITIONS, sites, principal.getRequestIdentity(), grants),
      call: async (name) => {
        if (name !== "drupal_list_nodes") return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
        const identity = principal.getRequestIdentity();
        const entitled = resolveGrantedSites(identity, sites, grants);
        if (!entitled.length) {
          return {
            content: [{ type: "text", text: "Access denied: Principal is not entitled to any configured target." }],
            isError: true,
          };
        }
        counters.countTool();
        const parts = [];
        for (const site of entitled) {
          const res = await fetch(`${site.baseUrl}/jsonapi/node/article`, {
            headers: { authorization: "Bearer upstream-synthetic" },
          });
          parts.push(await res.text());
        }
        return { content: [{ type: "text", text: parts.join("\n") }] };
      },
    },
    resources: { definitions: [], read: async () => ({}) },
    prompts: { definitions: [], get: () => [] },
  };
  const buildServer = mcpServer.createConnectorServerFactory(surface);
  const modern = createMcpHandler(buildServer, { legacy: "reject" });

  const handlerSwap = { ...swap };
  delete handlerSwap.resolveGrantedSites;
  delete handlerSwap.resolveInboundAuthMode;
  const deps = {
    // Production wiring in resource-server mode (index.js): checkAuth is closed.
    checkAuth: () => false,
    authenticate: inbound.authenticate,
    ...handlerSwap,
  };
  const handler = httpHandler.createMcpRequestHandler({
    ...deps,
    protectedResource: inbound.protectedResource,
    resourceMetadataUrl: inbound.resourceMetadataUrl,
    toolCount: TOOL_DEFINITIONS.length,
    modernHandler: counters.wrapHandler(toNodeHandler(modern)),
    legacyHandler: counters.wrapHandler(httpHandler.createLegacySessionHandler({ buildServer, mode: "serve" })),
    rateLimiter: rateLimit.createRateLimiter({ limit: FIXTURE_RATE_LIMIT, windowMs: 60_000, now: clock.now }),
  });

  const server = createServer((req, res) => {
    void handler(req, res).then(() => {
      tap.serverSide.push({ method: req.method, url: req.url, bodyRead: req.readableDidRead });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;

  const configDigest = createHash("sha256").update(JSON.stringify({
    issuer: issuer.issuer,
    audience: issuer.audience,
    requiredScopes: REQUIRED_SCOPES,
    grants,
    tools: TOOL_DEFINITIONS.map((tool) => tool.name),
    rateLimit: FIXTURE_RATE_LIMIT,
    mutant,
  })).digest("hex").slice(0, 16);

  const harness = {
    mutant,
    configDigest,
    url,
    resourceMetadataUrl: inbound.resourceMetadataUrl,
    counters,
    tap,
    fake,
    issuer,
    tenants: TENANTS,
    assertions: 0,
    clock,
    /** Mint a token for a tenant's client with the given scopes. */
    tokenFor: (tenant, scopes = ["mcp_connect", "mcp_read"], extra = {}) => {
      const { clientId } = TENANTS.find((entry) => entry.tenant === tenant);
      return issuer.mint({ sub: `${clientId}-subject`, azp: clientId, scope: scopes.join(" "), jti: `eval-${tenant}-1`, ...extra });
    },
    /**
     * Send one built request to /mcp and record the response in the tap.
     * @param {{method: string, headers: object, body?: string}} request
     * @param {{token?: string}} [options] Authorization is added only when a token is given.
     */
    async send(request, { token } = {}) {
      const headers = { ...request.headers, ...(token ? { authorization: `Bearer ${token}` } : {}) };
      const res = await fetch(url, { method: request.method, headers, body: request.body });
      const text = await res.text();
      const entry = { status: res.status, headers: Object.fromEntries(res.headers), text };
      tap.record(entry);
      return entry;
    },
    /** Wait until the server has finished `count` requests (server-side taps are recorded after the handler returns). */
    async waitServerSide(count) {
      for (let i = 0; i < 200 && tap.serverSide.length < count; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    /** Zero-dispatch snapshot: Ch, Ct, and Cu (all tenants). */
    dispatchCounts: () => ({ ch: counters.ch, ct: counters.ct, cu: fake.count() }),
    async close() {
      await modern.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await fake.close();
      clock.restore();
    },
  };
  return harness;
}
