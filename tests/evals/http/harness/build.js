/**
 * Compose the connector's HTTP transport the way production does: through
 * `startHttpsTransport` (the function `src/index.js` calls), over fakes,
 * behind a loopback server.
 *
 *   inbound auth : real `createInboundHttpsAuth` against the stub issuer
 *   startup      : real `startHttpsTransport` (index.js wiring)
 *   dispatch     : real SDK modern handler and real legacy session handler
 *   tools        : a stand-in surface over the fake upstream
 *
 * Mutants are dependency swaps at build time. They live here, in `tests/`.
 * `src/` has no eval switch.
 */

import { createHash } from "node:crypto";
import { request as nodeRequest } from "node:http";
import { EVAL_TOOL_NAMES } from "./labels.js";
import { installFakeClock } from "./clock.js";
import {
  anchor,
  evidence,
  httpAuth,
  httpAudit,
  httpsStartup,
  mcpServer,
  principal,
  rateLimit,
  relayEdge,
  toolScopes,
  usage,
} from "./connector.js";
import { createCounters } from "./counters.js";
import { createFakeDrupal } from "./fake-drupal.js";
import { createStubIssuer } from "./stub-issuer.js";
import { createTap } from "./taps.js";

/** Transport-required scope for the hosted configuration (fixture value). */
const REQUIRED_SCOPES = ["mcp_connect"];

/** Fixture per-source limit, high enough that no case reaches it. Not a recommendation. */
const FIXTURE_RATE_LIMIT = 1000;

const TENANTS = [
  { tenant: "A", site: "site-a", clientId: "client-a" },
  { tenant: "B", site: "site-b", clientId: "client-b" },
];

const TOOL_DEFINITIONS = [
  { name: "drupal_list_nodes", description: "List nodes (read).", inputSchema: { type: "object", properties: {} } },
  { name: "drupal_create_node", description: "Create a node (write).", inputSchema: { type: "object", properties: {} } },
  { name: "drupal_eval_unscoped", description: "Eval-only name with no scope-table row.", inputSchema: { type: "object", properties: {} } },
];

if (JSON.stringify(TOOL_DEFINITIONS.map((tool) => tool.name)) !== JSON.stringify([...EVAL_TOOL_NAMES])) {
  throw new Error("stand-in tools drifted from EVAL_TOOL_NAMES; add a case and update the manifest");
}

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
  resourceServer = null,
}) {
  const isLoopback = bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";
  const hasRs = Boolean(resourceServer?.issuer && resourceServer?.audience);
  if (hasRs) return { mode: "resource_server" };
  if (allowUnauth) return { mode: "unauthenticated" };
  if (isLoopback) return { mode: "unauthenticated" };
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

function sinkholeResponse() {
  return {
    statusCode: 200,
    headersSent: false,
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    end() { return this; },
    setHeader() { return this; },
    on() { return this; },
  };
}

/**
 * Dependency-swap mutants: each removes exactly one guard. Keyed by mutant
 * id (a case may declare more than one).
 */
const MUTANTS = {
  T1: () => ({ authenticate: null, checkAuth: () => true, allowLocalOperator: true }),
  // a-1: dispatch the modern handler, then still write 401. T1 must kill this
  // by asserting the handler was not reached — a status-only check would miss it.
  "T1-dispatch-before-auth": () => ({
    wrapRequestHandler: (_handler, ctx) => async (req, res) => {
      try {
        await ctx.modernHandler(req, sinkholeResponse());
      } catch {
        // Reaching the handler is the mutation; the 401 is written below.
      }
      httpAuth.writeUnauthorized(res, {
        error: "invalid_token",
        errorDescription: "Bearer token required",
        resourceMetadata: ctx.resourceMetadataUrl,
      });
    },
  }),
  T1n: () => ({ resolveInboundAuthMode: failOpenInboundAuthMode }),
  T2: acceptAnyAuth,
  T2a: acceptAnyAuth,
  T2e: acceptAnyAuth,
  T2s: acceptAnyAuth,
  T2m: acceptAnyAuth,
  T4: () => ({ resolveGrantedSites: allSitesGranted }),
  T4b: () => ({ resolveGrantedSites: fallThroughGrantedSites }),
  T7: () => ({
    authenticate: async () => httpAuth.denyAuth(401, {
      error: "invalid_token",
      errorDescription: "Token validation failed",
    }),
  }),
  T8: () => ({ auditWriter: null }),
  T9: () => ({ protocolVersionSupportedFn: () => true }),
  T10: () => ({ sessionPrincipalKeyFn: () => "eval-shared" }),
  T11: () => ({ originAllowedFn: () => true }),
  T12: () => ({ sessionlessMethodRefusedFn: () => false }),
  T13: () => ({ acceptOkFn: () => true }),
  T14: () => ({ isJsonRpcBatchFn: () => false }),
  T16: () => ({ isUnauthenticatedRouteFn: () => false }),
  // T15 (DEV-860): drop the verified-principal key so both tenants share
  // the address bucket (the pre-DEV-860 standalone /mcp behavior).
  T15: () => ({ principalRateKeyFn: () => null }),
  // T17 (DEV-862): restore the v3.2.x default (unknown tool -> mcp_read / listed + callable).
  T17: () => ({
    filterToolsByPrincipal: (defs) => defs,
    networkToolScopeDenial: () => null,
  }),
  // T18 (DEV-861): skip Host validation so a disallowed Host is served.
  T18: () => ({ hostAllowedFn: () => true }),
  // X1: treat every route as public so authenticated shapes skip gateAuth.
  "X1-public-all": () => ({ isUnauthenticatedRouteFn: () => true }),
  // Applied inside the scanner (surface / production options), not here.
  "X1-open-tools": () => ({}),
  "X1-seams": () => ({}),
};

/** Shared deny-twin mutant: any bearer becomes a verified principal. */
function acceptAnyAuth() {
  return {
    authenticate: async () => ({ ok: true, identity: { sub: "mutant", clientId: "client-a" } }),
  };
}

/**
 * Dependency swap for one mutant id. `buildHarness` is the only caller;
 * T1n uses `failOpenInboundAuthMode` directly plus this table.
 *
 * @param {string} id
 * @returns {object}
 */
function mutantSwap(id) {
  if (id !== null && !MUTANTS[id]) throw new Error(`Unknown mutant "${id}".`);
  return id && MUTANTS[id] ? MUTANTS[id]() : {};
}

function assertNoAmbientCredentials() {
  const ambient = Object.keys(process.env).filter((key) => /^(DRUPAL_|MCP_)/.test(key));
  if (ambient.length) {
    throw new Error(`Ambient connector variables are set (${ambient.join(", ")}). Run via "npm run eval:http".`);
  }
}

/**
 * @param {object} [options]
 * @param {string|null} [options.mutant] Mutant id, or null for the real build.
 * @param {object|null} [options.grants] Grant table; `null` is T4b (no table).
 * @param {number} [options.rateLimit] Per-key /mcp limit.
 * @param {(req: object) => string} [options.clientKey] Optional rate-limit key.
 * @param {boolean} [options.edge] Also start a northbound edge for /usage and /assessor.
 * @param {(row: object) => void} [options.auditSink] Audit sink (default: throw).
 * @param {Array<{clientId: string, sub: string}>} [options.allowedPrincipals] Optional admission policy.
 * @param {number} [options.principalRateLimit] Per-principal /mcp limit
 *   (default: fixture high water, so T8's address-only flood does not
 *   starve a later authenticated principal).
 * @returns {Promise<object>} harness handle
 */
export async function buildHarness({
  mutant = null,
  grants: grantsOption,
  rateLimit: rateLimitOpt,
  principalRateLimit: principalRateLimitOpt,
  clientKey,
  edge: withEdge = false,
  auditSink,
  allowedPrincipals,
} = {}) {
  assertNoAmbientCredentials();
  const swap = mutantSwap(mutant);

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
  const resolveGrantedSites = swap.resolveGrantedSites ?? principal.resolveGrantedSites;
  const filterToolsByPrincipal = swap.filterToolsByPrincipal ?? principal.filterToolsByPrincipal;
  const networkToolScopeDenial = swap.networkToolScopeDenial ?? toolScopes.networkToolScopeDenial;

  const inboundCfg = httpAuth.resolveInboundAuthConfig({ auth: {
    issuer: issuer.issuer,
    audience: issuer.audience,
    resource: issuer.audience,
    requiredScopes: REQUIRED_SCOPES,
    revocationFile: "",
    introspectionUrl: issuer.introspectionUrl,
    introspectionClientId: "eval-rs",
    introspectionClientSecret: "eval-rs-secret",
    ...(allowedPrincipals !== undefined ? { allowedPrincipals } : {}),
  } }, {});

  const surface = {
    serverInfo: { name: "eval-http-connector", version: "0" },
    tools: {
      definitions: TOOL_DEFINITIONS,
      list: async () => filterToolsByPrincipal(
        TOOL_DEFINITIONS, sites, principal.getRequestIdentity(), grants),
      call: async (name) => {
        const identity = principal.getRequestIdentity();
        const scopeDenial = networkToolScopeDenial(name);
        if (scopeDenial) {
          return {
            content: [{ type: "text", text: `Access denied: ${scopeDenial}` }],
            isError: true,
          };
        }
        if (name !== "drupal_list_nodes" && name !== "drupal_eval_unscoped") {
          return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
        }
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

  const handlerSwap = { ...swap };
  delete handlerSwap.resolveGrantedSites;
  delete handlerSwap.resolveInboundAuthMode;
  delete handlerSwap.filterToolsByPrincipal;
  delete handlerSwap.networkToolScopeDenial;
  delete handlerSwap.wrapRequestHandler;
  const sink = auditSink ?? (() => {
    throw new Error("eval audit sink failed (fail-safe: must not change the HTTP verdict)");
  });
  const evalWriter = httpAudit.createHttpAuditWriter({ sink });
  const auditWriter = handlerSwap.auditWriter !== undefined
    ? handlerSwap.auditWriter
    : evalWriter;
  delete handlerSwap.auditWriter;
  const checkAuth = handlerSwap.checkAuth;
  delete handlerSwap.checkAuth;
  const authenticate = handlerSwap.authenticate;
  delete handlerSwap.authenticate;
  const allowLocalOperator = handlerSwap.allowLocalOperator;
  delete handlerSwap.allowLocalOperator;

  const wrapRequestHandler = (handler, ctx) => {
    const mutated = swap.wrapRequestHandler ? swap.wrapRequestHandler(handler, ctx) : handler;
    return async (req, res) => {
      try {
        await mutated(req, res);
      } finally {
        tap.serverSide.push({ method: req.method, url: req.url, bodyRead: req.readableDidRead });
      }
    };
  };

  const started = await httpsStartup.startHttpsTransport({
    bindHost: "127.0.0.1",
    port: 0,
    allowHttp: true,
    allowUnauth: false,
    inboundCfg,
    tls: null,
    buildServer,
    legacyMode: "serve",
    rateLimiter: rateLimit.createRateLimiter({
      limit: rateLimitOpt ?? FIXTURE_RATE_LIMIT,
      windowMs: 60_000,
      now: clock.now,
    }),
    principalLimiter: rateLimit.createRateLimiter({
      limit: principalRateLimitOpt ?? FIXTURE_RATE_LIMIT,
      windowMs: 60_000,
      now: clock.now,
    }),
    fetchFn: issuer.fetchFn,
    auditWriter,
    ...(checkAuth !== undefined ? { checkAuth } : {}),
    ...(authenticate !== undefined ? { authenticate } : {}),
    ...(allowLocalOperator !== undefined ? { allowLocalOperator } : {}),
    ...(clientKey ? { clientKey } : {}),
    handlerOverrides: handlerSwap,
    wrapHandler: (handler) => counters.wrapHandler(handler),
    wrapRequestHandler,
    resolveInboundAuthModeFn: swap.resolveInboundAuthMode ?? httpAuth.resolveInboundAuthMode,
    exit: (code, reason) => {
      throw new Error(`HTTPS startup exited (${code}): ${reason}`);
    },
    log: () => {},
  });
  if (!started.started) {
    throw new Error(`HTTPS startup refused to listen: ${started.reason}`);
  }

  const origin = started.url.replace(/\/mcp$/, "");
  let edgeHandle = null;
  if (withEdge) {
    const keys = anchor.generateNotaryKeys();
    edgeHandle = await relayEdge.startEdge({
      auth: inboundCfg,
      grants: grants || { "client-a": ["site-a"] },
      tenantGrants: { "client-a": ["tenant-a"] },
      sites: [{ _name: "site-a" }],
      defaultSite: "site-a",
      channelCredentials: { lookup: () => null },
      allowHttpLoopback: true,
      fetchFn: issuer.fetchFn,
      usage: usage.createUsageLedger(),
      evidence: evidence.createEvidenceLedger(),
      evidenceAnchor: { publicKey: keys.publicPin, submit: () => ({ ok: false }) },
      auditWriter,
    });
  }

  const configDigest = createHash("sha256").update(JSON.stringify({
    issuer: issuer.issuer,
    audience: issuer.audience,
    requiredScopes: REQUIRED_SCOPES,
    grants,
    tools: TOOL_DEFINITIONS.map((tool) => tool.name),
    rateLimit: rateLimitOpt ?? FIXTURE_RATE_LIMIT,
    principalRateLimit: principalRateLimitOpt ?? FIXTURE_RATE_LIMIT,
    mutant,
    audit: auditWriter !== null,
    edge: withEdge,
  })).digest("hex").slice(0, 16);

  const harness = {
    mutant,
    configDigest,
    url: started.url,
    origin,
    resourceMetadataUrl: started.resourceMetadataUrl,
    edgeUrl: edgeHandle?.northboundUrl ?? null,
    counters,
    tap,
    auditRows: evalWriter.rows,
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
     * Send one built request. `request.path` or `options.path` selects a
     * non-`/mcp` route; `options.base` selects the edge origin.
     * @param {{method: string, headers: object, body?: string, path?: string}} request
     * @param {{token?: string, headers?: object, requestId?: string, path?: string, base?: string}} [options]
     */
    async send(request, { token, headers: extra = {}, requestId, path, base } = {}) {
      const route = path || request.path || "/mcp";
      const root = (base || origin).replace(/\/mcp$/, "");
      const headers = {
        ...request.headers,
        ...extra,
        ...(requestId ? { "x-request-id": requestId } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
      const hostOverride = headers.host ?? headers.Host;
      let entry;
      if (hostOverride) {
        // undici fetch forbids setting Host; node:http is how T18 presents a
        // disallowed Host against the loopback listener.
        entry = await new Promise((resolve, reject) => {
          const parsed = new URL(`${root}${route}`);
          const req = nodeRequest({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: request.method,
            headers,
          }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              resolve({
                status: res.statusCode,
                headers: { ...res.headers },
                text: Buffer.concat(chunks).toString("utf8"),
                route,
              });
            });
          });
          req.on("error", reject);
          if (request.body !== undefined) req.write(request.body);
          req.end();
        });
      } else {
        const res = await fetch(`${root}${route}`, { method: request.method, headers, body: request.body });
        const text = await res.text();
        entry = { status: res.status, headers: Object.fromEntries(res.headers), text, route };
      }
      tap.record(entry);
      return entry;
    },
    /** Wait until the server has finished `count` requests. */
    async waitServerSide(count) {
      for (let i = 0; i < 200 && tap.serverSide.length < count; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    dispatchCounts: () => ({ ch: counters.ch, ct: counters.ct, cu: fake.count() }),
    async close() {
      await started.close?.();
      await edgeHandle?.close?.();
      await fake.close();
      clock.restore();
    },
  };
  return harness;
}

export { failOpenInboundAuthMode };
