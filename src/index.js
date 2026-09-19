#!/usr/bin/env node
/**
 * drupal-mcp-connector — entry point
 *
 * Transports:
 *   stdio (default)   Local subprocess mode for MCP clients
 *   https             Multi-client remote mode. HTTPS always; HTTP refused on
 *                     non-localhost unless MCP_ALLOW_HTTP=1 is explicitly set.
 *
 * Environment variables:
 *   MCP_TRANSPORT     "stdio" (default) | "https"
 *   MCP_PORT          Port for HTTPS mode (default: 3443)
 *   TLS_CERT_PATH     Path to TLS certificate (PEM)
 *   TLS_KEY_PATH      Path to TLS private key (PEM)
 *   DRUPAL_BASE_URL   Single-site fallback baseUrl
 *   DRUPAL_API_TOKEN  Single-site fallback Bearer token
 *   MCP_ALLOW_HTTP    Set to "1" to allow plain HTTP on localhost only (dev)
 *   MCP_AUTH_TOKEN    Loopback-only shared bearer for /mcp (not accepted network-facing)
 *   MCP_RESOURCE_ISSUER / MCP_RESOURCE_AUDIENCE / MCP_RESOURCE
 *                     Inbound OAuth resource-server (required beyond loopback)
 *   MCP_BIND_HOST     Bind address for https mode when TLS is present
 *                     (default: "0.0.0.0"; ignored without TLS, which forces loopback)
 *   MCP_RATE_LIMIT    Max /mcp requests per window per client IP (0/unset = off)
 *   MCP_RATE_WINDOW_SEC  Rate-limit window in seconds (default: 60)
 *   MCP_LEGACY_TRANSPORT "serve" (default) | "reject" for 2025-era clients
 */

import { createServer as createHttpsServer } from "https";
import { createServer as createHttpServer }  from "http";
import { readFileSync }                      from "fs";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";

import { listSiteNames, getTlsConfig, loadConfig, CLIENT_VERSION, SERVER_INFO } from "./lib/config.js";
import { loadLocalSecrets, secretLoadFatalMessage, secretTableMismatchMessage } from "./lib/load-secrets.js";
import {
  makeBearerCheck,
  resolveInboundAuthConfig,
  resolveInboundAuthMode,
  inboundAuthDeprecationWarning,
  createInboundHttpsAuth,
} from "./lib/http-auth.js";
import { createLegacySessionHandler, createMcpRequestHandler } from "./lib/http-handler.js";
import { createConnectorServerFactory } from "./lib/mcp-server.js";
import { createRateLimiter } from "./lib/rate-limit.js";
import { callTool, listResolvableSiteConfigs } from "./lib/dispatch.js";
import { filterDiscoverableTools } from "./lib/governance.js";
import {
  assertPrincipalEntitlement,
  filterPromptsByPrincipal,
  filterResourcesByPrincipal,
  filterToolsByPrincipal,
  getRequestIdentity,
  visibleSiteTargets,
} from "./lib/principal.js";

// Tools — aggregated (single source of truth, side-effect-free) and per-tool prompts
import { allDefinitions, allHandlers, definitionsByName } from "./tools/index.js";
import { createModuleToolRegistry, isModuleTool } from "./lib/module-tools.js";
import { buildToolPrompts, createPromptSurface } from "./lib/tool-prompts.js";
import {
  loadWorkflows,
  toPromptDescriptor,
  renderWorkflowMessages,
  moduleWorkflowProviders,
  registerBuiltinWorkflows,
  replaceModuleWorkflows,
} from "./lib/workflow-prompts.js";
import { builtinWorkflowProvider } from "./lib/workflows/builtin.js";

// Apply config/secrets.map (or the shipped example table) before any site
// resolution. MCP clients spawn this file directly; the shell launcher is
// not guaranteed to have run.
const secretLoad = loadLocalSecrets();
const secretFatal = secretLoadFatalMessage(secretLoad);
if (secretFatal) {
  console.error(`[drupal-mcp-connector] FATAL: ${secretFatal}`);
  process.exit(1);
}
const secretMismatch = secretTableMismatchMessage(secretLoad);
if (secretMismatch) {
  console.error(`[drupal-mcp-connector] WARNING: ${secretMismatch}`);
} else if (secretLoad.unset.length) {
  console.error(
    "[drupal-mcp-connector] WARNING: config.json names secret env vars that are unset: " +
    `${secretLoad.unset.join(", ")}. Those sites will fail closed.`
  );
}

// ---------------------------------------------------------------------------
// MCP Resources — browsable, always-fresh site context
// ---------------------------------------------------------------------------

const RESOURCES = [
  {
    uri:         "drupal://sites",
    name:        "Configured Drupal Sites",
    description: "All named Drupal site profiles (no credentials).",
    mimeType:    "application/json",
  },
  {
    uri:         "drupal://{site}/content-types",
    name:        "Content Types",
    description: "All content types with machine names and descriptions.",
    mimeType:    "application/json",
  },
  {
    uri:         "drupal://{site}/security-policy",
    name:        "Security Policy",
    description: "Active security configuration for this site.",
    mimeType:    "application/json",
  },
];

const moduleTools = createModuleToolRegistry();

async function discoverableTools() {
  const sites = listResolvableSiteConfigs();
  const identity = getRequestIdentity();
  const governed = await filterDiscoverableTools(allDefinitions, sites);
  return [
    ...filterToolsByPrincipal(governed, sites, identity),
    ...await moduleTools.list({ sites, identity }),
  ];
}

/**
 * Resolve a resource URI to its JSON payload. URIs are matched in order; the
 * templated forms (content-types, security-policy) capture the site name and
 * delegate to the corresponding read-only tool handler so resources and tools
 * always return the same shape.
 *
 * @param {string} uri - A drupal:// resource URI.
 * @returns {Promise<object>} The resource data (later JSON-serialized).
 * @throws {Error} If the URI matches no known resource.
 */
async function readResource(uri) {
  const identity = getRequestIdentity();
  const sites = listResolvableSiteConfigs();

  // drupal://sites
  if (uri === "drupal://sites") {
    return visibleSiteTargets(identity, sites, listSiteNames());
  }

  // drupal://{site}/content-types
  const ctMatch = uri.match(/^drupal:\/\/([^/]+)\/content-types$/);
  if (ctMatch) {
    assertPrincipalEntitlement({
      toolName: "drupal_list_content_types",
      args: { site: ctMatch[1] },
      identity,
      sites,
    });
    return allHandlers.drupal_list_content_types({ site: ctMatch[1] });
  }

  // drupal://{site}/security-policy
  const spMatch = uri.match(/^drupal:\/\/([^/]+)\/security-policy$/);
  if (spMatch) {
    assertPrincipalEntitlement({
      toolName: "drupal_security_info",
      args: { site: spMatch[1] },
      identity,
      sites,
    });
    return allHandlers.drupal_security_info({ site: spMatch[1] });
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}

// ---------------------------------------------------------------------------
// MCP Prompts — common Drupal workflow templates
// ---------------------------------------------------------------------------

const builtinWorkflows = loadWorkflows([builtinWorkflowProvider], { tools: allDefinitions });
registerBuiltinWorkflows(builtinWorkflows);
const PROMPTS = builtinWorkflows.map(toPromptDescriptor);

// Per-tool prompts: one slash-command prompt for every Drupal tool, derived from
// the tool definitions so the set always matches the tools. Merged after the
// workflow prompts (names never collide — workflow prompts use composite verbs,
// tool prompts mirror the `drupal_*` tool names).
const WORKFLOW_PROMPT_NAMES = new Set(PROMPTS.map((p) => p.name));
const TOOL_PROMPTS = buildToolPrompts(allDefinitions);
const ALL_PROMPTS  = [...PROMPTS, ...TOOL_PROMPTS];

/**
 * Build the message list for a named built-in workflow. Unknown names fall
 * back to a generic one-line instruction so the call never fails.
 *
 * @param {string} name - The prompt name.
 * @param {object} args - Prompt arguments (site, type, topic — all optional).
 * @returns {Array<object>} MCP prompt messages.
 */
function getPromptMessages(name, args) {
  const workflow = builtinWorkflows.find((item) => item.name === name);
  if (workflow) return renderWorkflowMessages(workflow, args);
  const site = args?.site ? `on the "${args.site}" site` : "on the default site";
  return [{ role: "user", content: { type: "text", text: `Run the ${name} workflow ${site}.` } }];
}

// ---------------------------------------------------------------------------
// MCP Server surface — dispatch (middleware + callTool) lives in lib/dispatch.js
// ---------------------------------------------------------------------------

const buildConnectorServer = createConnectorServerFactory({
  serverInfo: SERVER_INFO,
  tools: {
    definitions: allDefinitions,
    list: discoverableTools,
    call: (name, args, context) => isModuleTool(name)
      ? moduleTools.call(name, args, context)
      : callTool(name, args, context),
  },
  resources: {
    definitions: RESOURCES,
    list: async () => {
      const sites = listResolvableSiteConfigs();
      return filterResourcesByPrincipal(RESOURCES, getRequestIdentity(), sites);
    },
    read: readResource,
  },
  prompts: createPromptSurface({
    staticPrompts: ALL_PROMPTS,
    discover: discoverableTools,
    filter: (prompts, tools) => filterPromptsByPrincipal(prompts, getRequestIdentity(), tools),
    workflowNames: WORKFLOW_PROMPT_NAMES,
    workflowMessages: getPromptMessages,
    definitionsByName,
    extraWorkflows: (tools, taken) => {
      const loaded = loadWorkflows(moduleWorkflowProviders(listResolvableSiteConfigs()), { tools, taken });
      replaceModuleWorkflows(loaded);
      return loaded;
    },
    extraWorkflowMessages: renderWorkflowMessages,
  }),
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const transport = process.env.MCP_TRANSPORT || "stdio";
const reportMcpTransportStage = (stage) => {
  console.error(`[drupal-mcp-connector] MCP ${stage} failed.`);
};

if (transport === "stdio") {
  serveStdio(buildConnectorServer, {
    legacy: "serve",
    onerror: () => reportMcpTransportStage("stdio-dispatch"),
  });
  console.error(
    `[drupal-mcp-connector v${CLIENT_VERSION}] stdio transport active. ` +
    `${allDefinitions.length} tools · ${RESOURCES.length} resources · ${ALL_PROMPTS.length} prompts`
  );

} else if (transport === "https" || transport === "http") {
  const tlsCfg     = getTlsConfig();
  const port       = tlsCfg.port;
  const allowHttp  = process.env.MCP_ALLOW_HTTP === "1";

  const authToken   = process.env.MCP_AUTH_TOKEN || "";
  const allowUnauth = process.env.MCP_ALLOW_UNAUTHENTICATED === "1";

  // Security headers applied to every response
  function applySecurityHeaders(res) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    res.setHeader("X-Content-Type-Options",    "nosniff");
    res.setHeader("X-Frame-Options",           "DENY");
    res.setHeader("Referrer-Policy",           "no-referrer");
    res.setHeader("Cache-Control",             "no-store");
    res.setHeader("Content-Security-Policy",   "default-src 'none'");
  }

  function createNodeServer(onRequest) {
    if (tlsCfg.certPath && tlsCfg.keyPath) {
      // HTTPS — the only acceptable mode for non-local deployments
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- TLS cert/key path comes from operator-controlled config, not user input
      const cert = readFileSync(tlsCfg.certPath);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- TLS cert/key path comes from operator-controlled config, not user input
      const key  = readFileSync(tlsCfg.keyPath);
      return createHttpsServer({ cert, key }, (req, res) => {
        applySecurityHeaders(res);
        onRequest(req, res);
      });
    }

    // No TLS certs — allow only if explicitly opted in AND on localhost
    if (!allowHttp) {
      console.error(
        "[drupal-mcp-connector] FATAL: HTTP transport requires TLS certificates.\n" +
        "  Set TLS_CERT_PATH and TLS_KEY_PATH, or MCP_ALLOW_HTTP=1 for localhost-only dev.\n" +
        "  See docs/getting-started.md for TLS setup instructions."
      );
      process.exit(1);
    }

    console.error(
      "[drupal-mcp-connector] WARNING: Running plain HTTP (MCP_ALLOW_HTTP=1). " +
      "ONLY acceptable for local development. Never expose this to the internet."
    );
    return createHttpServer((req, res) => {
      applySecurityHeaders(res);
      onRequest(req, res);
    });
  }

  const hasTls   = Boolean(tlsCfg.certPath && tlsCfg.keyPath);
  // Unauthenticated plain HTTP must never bind beyond loopback. A non-loopback
  // bind is allowed only alongside TLS, via an explicit MCP_BIND_HOST opt-in.
  const bindHost = hasTls ? (process.env.MCP_BIND_HOST || "0.0.0.0") : "127.0.0.1";
  const isLoopbackBind = bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";

  const inboundCfg = resolveInboundAuthConfig(loadConfig());
  const inboundMode = resolveInboundAuthMode({
    bindHost,
    allowUnauth,
    sharedToken: authToken,
    resourceServer: inboundCfg,
  });
  if (inboundMode.mode === "fatal") {
    console.error(`[drupal-mcp-connector] FATAL: ${inboundMode.reason}`);
    process.exit(1);
  }
  const deprecation = inboundAuthDeprecationWarning(inboundMode.mode);
  if (deprecation) console.error(deprecation);

  let checkAuth = makeBearerCheck(inboundMode.mode === "shared_bearer" ? authToken : "");
  let authenticate = null;
  let protectedResource = null;
  if (inboundMode.mode === "resource_server") {
    try {
      const inbound = await createInboundHttpsAuth({ inboundCfg });
      authenticate = inbound.authenticate;
      protectedResource = inbound.protectedResource;
      checkAuth = () => false;
      console.error(
        `[drupal-mcp-connector] Inbound OAuth resource server: issuer ${inboundCfg.issuer}`
      );
    } catch (error) {
      console.error(
        "[drupal-mcp-connector] FATAL: inbound issuer discovery failed.\n" +
        `  ${error instanceof Error ? error.message : "unknown error"}`
      );
      process.exit(1);
    }
  } else if (inboundMode.mode === "unauthenticated" && !allowUnauth) {
    console.error(
      "[drupal-mcp-connector] WARNING: the /mcp endpoint is UNAUTHENTICATED. " +
      "Acceptable only on loopback or behind a trusted auth boundary."
    );
  }

  // Optional fixed-window rate limiting on /mcp, keyed by client IP.
  // HTTPS non-loopback defaults to 120 req/min when MCP_RATE_LIMIT is unset (#141).
  // Set MCP_RATE_LIMIT=0 to disable. Counts are per-process; multi-replica should
  // also rate-limit at the reverse proxy.
  const rateWindowSec = Number(process.env.MCP_RATE_WINDOW_SEC || 60);
  const rateLimitEnv  = process.env.MCP_RATE_LIMIT;
  const rateLimitDefault = (hasTls && !isLoopbackBind) ? 120 : 0;
  const rateLimit = rateLimitEnv === undefined || rateLimitEnv === ""
    ? rateLimitDefault
    : Number(rateLimitEnv);
  const rateLimiter   = rateLimit > 0
    ? createRateLimiter({ limit: rateLimit, windowMs: rateWindowSec * 1000 })
    : null;
  if (rateLimiter) {
    console.error(
      `[drupal-mcp-connector] Rate limiting: ${rateLimit} req / ${rateWindowSec}s per client IP on /mcp.`
    );
  }

  const legacyMode = process.env.MCP_LEGACY_TRANSPORT || "serve";
  const modernMcpHandler = createMcpHandler(buildConnectorServer, {
    legacy: "reject",
    onerror: () => reportMcpTransportStage("modern-protocol"),
  });
  const modernHandler = toNodeHandler(modernMcpHandler, {
    onerror: () => reportMcpTransportStage("modern-adapter"),
  });
  const legacyHandler = createLegacySessionHandler({
    buildServer: buildConnectorServer,
    mode: legacyMode,
  });
  const requestHandler = createMcpRequestHandler({
    checkAuth,
    authenticate,
    protectedResource,
    modernHandler,
    legacyHandler,
    toolCount: allDefinitions.length,
    rateLimiter,
  });

  const nodeServer = createNodeServer(requestHandler);

  nodeServer.listen(port, bindHost, () => {
    const proto = hasTls ? "https" : "http";
    console.error(
      `[drupal-mcp-connector v${CLIENT_VERSION}] Listening on ${proto}://${bindHost}:${port}/mcp\n` +
      `  ${allDefinitions.length} tools · ${RESOURCES.length} resources · ${ALL_PROMPTS.length} prompts`
    );
  });

} else {
  console.error(`[drupal-mcp-connector] Unknown MCP_TRANSPORT: "${transport}". Use "stdio" or "https".`);
  process.exit(1);
}
