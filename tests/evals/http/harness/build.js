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
const MUTANTS = {
  // T1: the handler defaults. Every request now dispatches under null identity.
  T1: () => ({ authenticate: null, checkAuth: () => true }),
  // T7: an authenticator that rejects everything (the over-blocking check).
  T7: () => ({
    authenticate: async () => httpAuth.denyAuth(401, {
      error: "invalid_token",
      errorDescription: "Token validation failed",
    }),
  }),
};

/** @returns {string[]} case ids that have a dependency-swap mutant */
export const mutantIds = () => Object.keys(MUTANTS);

function assertNoAmbientCredentials() {
  const ambient = Object.keys(process.env).filter((key) => /^(DRUPAL_|MCP_)/.test(key));
  if (ambient.length) {
    throw new Error(`Ambient connector variables are set (${ambient.join(", ")}). Run via "npm run eval:http".`);
  }
}

/**
 * @param {{mutant?: string|null}} [options] Case id of the dependency-swap mutant, or null for the real build.
 * @returns {Promise<object>} harness handle
 */
export async function buildHarness({ mutant = null } = {}) {
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
  const grants = Object.fromEntries(TENANTS.map(({ clientId, site }) => [clientId, [site]]));

  const inboundCfg = {
    issuer: issuer.issuer,
    audience: issuer.audience,
    resource: issuer.audience,
    requiredScopes: REQUIRED_SCOPES,
    revocationFile: "",
    introspectionUrl: "",
  };
  const inbound = await httpAuth.createInboundHttpsAuth({ inboundCfg, fetchFn: issuer.fetchFn });

  const surface = {
    serverInfo: { name: "eval-http-connector", version: "0" },
    tools: {
      definitions: TOOL_DEFINITIONS,
      list: async () => principal.filterToolsByPrincipal(
        TOOL_DEFINITIONS, sites, principal.getRequestIdentity(), grants),
      call: async (name) => {
        counters.countTool();
        if (name !== "drupal_list_nodes") return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
        const identity = principal.getRequestIdentity();
        const entitled = principal.resolveGrantedSites(identity, sites, grants);
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

  const deps = {
    // Production wiring in resource-server mode (index.js): checkAuth is closed.
    checkAuth: () => false,
    authenticate: inbound.authenticate,
    ...(mutant ? MUTANTS[mutant]() : {}),
  };
  const handler = httpHandler.createMcpRequestHandler({
    ...deps,
    protectedResource: inbound.protectedResource,
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
