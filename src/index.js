#!/usr/bin/env node
/**
 * drupal-mcp-connector — entry point
 *
 * Transports:
 *   stdio (default)   Local subprocess mode for MCP clients
 *   https             Multi-client remote mode. HTTPS always; HTTP refused on
 *                     non-localhost unless MCP_ALLOW_HTTP=1 is explicitly set.
 *   http              Alias of `https` (accepted since before 5.0.0). Same TLS
 *                     rules — this is not a cleartext transport.
 *
 * Environment variables:
 *   MCP_TRANSPORT     "stdio" (default) | "https" | "http" (https alias)
 *   MCP_PORT          Port for HTTPS mode (default: 3443)
 *   TLS_CERT_PATH     Path to TLS certificate (PEM)
 *   TLS_KEY_PATH      Path to TLS private key (PEM)
 *   DRUPAL_BASE_URL   Single-site fallback baseUrl
 *   DRUPAL_API_TOKEN  Single-site fallback Bearer token
 *   MCP_ALLOW_HTTP    Set to "1" to allow plain HTTP on localhost only (dev)
 *   MCP_AUTH_TOKEN    Removed in 4.0.0 (#231); setting it is fatal at startup
 *   MCP_RESOURCE_ISSUER / MCP_RESOURCE_AUDIENCE / MCP_RESOURCE
 *                     Inbound OAuth resource-server (required beyond loopback)
 *   MCP_BIND_HOST     Bind address for https mode when TLS is present
 *                     (default: "0.0.0.0"; ignored without TLS, which forces loopback)
 *   MCP_RATE_LIMIT    Max /mcp requests per window per client address
 *                     (unauthenticated) and, unless overridden, per verified
 *                     principal (0/unset = off on loopback; 120 on non-loopback TLS)
 *   MCP_PRINCIPAL_RATE_LIMIT  Optional post-auth principal limit override
 *   MCP_RATE_WINDOW_SEC  Rate-limit window in seconds (default: 60)
 *   MCP_RATE_MAX_KEYS Hard cap on tracked limiter keys (default: 10000)
 *   MCP_TRUSTED_PROXIES  CIDR/IP list allowed to set X-Forwarded-For
 *                     (default: empty — trust none)
 *   MCP_LEGACY_TRANSPORT "serve" (default) | "reject" for 2025-era clients
 *   MCP_ALLOWED_ORIGINS Comma/space-separated Origin allowlist (DNS-rebinding);
 *                     exact https origins only, no wildcards or suffix
 *                     match. Not authentication: a missing Origin is
 *                     allowed for non-browser clients. Omitted/empty extra
 *                     list refuses every present third-party Origin
 *                     (DEV-953); the origin of auth.resource/audience is
 *                     still included (same-origin). A present empty value
 *                     clears the extra list. Hosted Cursor / Grok Bot
 *                     clients: https://cursor.com, https://www.cursor.com,
 *                     https://grok.com, https://console.x.ai.
 *   MCP_ALLOWED_HOSTS   Comma/space-separated Host allowlist (DEV-861);
 *                     a present empty value clears the configured list.
 *                     Default: host of auth.resource/audience, plus loopback
 *                     hostnames on a loopback bind.
 *   MCP_CATALOG_SITE_DEADLINE_MS  Listing wait for tools/list + prompts/list
 *                     (default: 4000). The wait never aborts the site chain.
 *                     A site that is not ready is omitted from that response.
 *   MCP_CATALOG_CACHE_TTL_MS  Success TTL for a per-site catalog snapshot
 *                     shared by tools/list, prompts/list, prompts/get
 *                     (default: 600000, stale-while-revalidate).
 *   MCP_CATALOG_NEGATIVE_TTL_MS  Error TTL so a cold start does not stampede
 *                     (default: 5000). A denial is never cached as a grant.
 *   MCP_CATALOG_CONCURRENCY  Concurrent site walks (default: 16).
 *   MCP_OPS_LISTEN    Optional mesh-only ops listener <addr:port> (DEV-863).
 *                     Disabled when unset. Loopback or Tailscale only
 *                     (100.64.0.0/10, fd7a:115c:a1e0::/48). 0.0.0.0, ::,
 *                     port 0, and any other public or non-mesh address
 *                     are fatal. No auth on this socket; confirm a
 *                     100.64/10 bind is Tailscale and restrict the port
 *                     with Tailscale ACLs. Serves GET /ready and
 *                     GET /metrics; the public listener does not.
 *
 * CLI subcommands (anything else starts the MCP server):
 *   wizard | init     Operator install wizard — see src/lib/wizard.js
 *   doctor            Connection doctor — see src/lib/doctor.js
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { listSiteNames, getTlsConfig, loadConfig, CLIENT_VERSION, SERVER_INFO } from "./lib/config.js";
import { loadLocalSecrets, secretLoadFatalMessage, secretTableMismatchMessage } from "./lib/load-secrets.js";
import {
  resolveInboundAuthConfig,
  isLoopbackBind,
} from "./lib/http-auth.js";
import {
  buildProductionHttpsOptions,
  createStartupRateLimiters,
  installHttpsShutdown,
  startHttpsTransport,
} from "./lib/https-startup.js";
import { createOpsMetrics } from "./lib/ops-metrics.js";
import { resolveOpsListen } from "./lib/ops-bind.js";
import { startOpsListener } from "./lib/ops-listener.js";
import { createConnectorServerFactory } from "./lib/mcp-server.js";
import { resolveTrustedProxies } from "./lib/client-address.js";
import { assertHostedToolScopeTable } from "./lib/tool-scopes.js";
import { callTool, invokeReadTool, listResolvableSiteConfigs } from "./lib/dispatch.js";
import { fetchTextFormatContext, installTextFormatContextFetcher } from "./lib/text-format-context.js";
import { filterDiscoverableTools } from "./lib/governance.js";
import { getCatalogDiscoveryOptions, prefetchSiteCatalogs } from "./lib/site-catalog.js";
import {
  filterPromptsByPrincipal,
  filterResourcesByPrincipal,
  filterToolsByPrincipal,
  getRequestIdentity,
  visibleSiteTargets,
} from "./lib/principal.js";

// Tools — aggregated (single source of truth, side-effect-free) and per-tool prompts
import { allDefinitions, definitionsByName } from "./tools/index.js";
import { createModuleToolRegistry, createSiteCatalogWork, isModuleTool } from "./lib/module-tools.js";
import { buildToolPrompts, createPromptSurface } from "./lib/tool-prompts.js";
import {
  loadWorkflows,
  toPromptDescriptor,
  renderWorkflowMessages,
  moduleWorkflowProvidersWithRemote,
  registerBuiltinWorkflows,
  replaceModuleWorkflows,
} from "./lib/workflow-prompts.js";
import { builtinWorkflowProvider } from "./lib/workflows/builtin.js";
import { runWizardCli } from "./lib/wizard.js";
import { runDoctorCli } from "./lib/doctor.js";

installTextFormatContextFetcher(fetchTextFormatContext);

const cliCommand = process.argv[2];
if (cliCommand === "wizard" || cliCommand === "init") {
  process.exit(await runWizardCli(process.argv.slice(3)));
}
if (cliCommand === "doctor") {
  process.exit(await runDoctorCli(process.argv.slice(3)));
}

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

/**
 * Warm per-site catalogs without blocking serveStdio or HTTP listen.
 * Process start uses the local principal; MCP initialize uses the request
 * identity so a hosted session prefetches its own bucket.
 *
 * @returns {void}
 */
function warmSiteCatalogs() {
  try {
    const sites = listResolvableSiteConfigs();
    const identity = getRequestIdentity();
    prefetchSiteCatalogs(sites, {
      identity,
      work: createSiteCatalogWork({ sites, identity }),
    });
  } catch {
    // Config or site resolution can fail before listen; warming is best-effort.
  }
}

async function discoverableTools() {
  const sites = listResolvableSiteConfigs();
  const identity = getRequestIdentity();
  const { siteDeadlineMs } = getCatalogDiscoveryOptions();
  const [governed, moduleDefs] = await Promise.all([
    filterDiscoverableTools(allDefinitions, sites, { timeoutMs: siteDeadlineMs }),
    moduleTools.list({ sites, identity }),
  ]);
  return [
    ...filterToolsByPrincipal(governed, sites, identity),
    ...moduleDefs,
  ];
}

/**
 * Resolve a resource URI to its JSON payload. URIs are matched in order; the
 * templated forms (content-types, security-policy) capture the site name and
 * go through {@link invokeReadTool} so resources and tools share middleware.
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
    return invokeReadTool("drupal_list_content_types", { site: ctMatch[1] });
  }

  // drupal://{site}/security-policy
  const spMatch = uri.match(/^drupal:\/\/([^/]+)\/security-policy$/);
  if (spMatch) {
    return invokeReadTool("drupal_security_info", { site: spMatch[1] });
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
  oninitialized: warmSiteCatalogs,
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
    extraWorkflows: async (tools, taken) => {
      const loaded = loadWorkflows(
        await moduleWorkflowProvidersWithRemote(listResolvableSiteConfigs(), {
          identity: getRequestIdentity(),
        }),
        { tools, taken },
      );
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

warmSiteCatalogs();

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
  try {
    assertHostedToolScopeTable(allDefinitions);
  } catch (error) {
    console.error(`[drupal-mcp-connector] FATAL: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const tlsCfg     = getTlsConfig();
  const allowHttp  = process.env.MCP_ALLOW_HTTP === "1";
  const authToken   = process.env.MCP_AUTH_TOKEN || "";
  const allowUnauth = process.env.MCP_ALLOW_UNAUTHENTICATED === "1";
  const hasTls   = Boolean(tlsCfg.certPath && tlsCfg.keyPath);
  // Unauthenticated plain HTTP must never bind beyond loopback. A non-loopback
  // bind is allowed only alongside TLS, via an explicit MCP_BIND_HOST opt-in.
  const bindHost = hasTls ? (process.env.MCP_BIND_HOST || "0.0.0.0") : "127.0.0.1";
  const config = loadConfig();
  const inboundCfg = resolveInboundAuthConfig(config);
  // Fixed-window rate limiting on /mcp (DEV-860). Unauthenticated requests
  // are keyed by client address before auth; authenticated requests are keyed
  // by the verified principal (sub+clientId). Limits, window, and the
  // non-loopback TLS default (120/min, #141) are resolved once in
  // createStartupRateLimiters and only logged here. Counts are per-process;
  // multi-replica should also rate-limit at the reverse proxy.
  // X-Forwarded-For is honored only from the trusted-proxy list (default: none).
  const limits = createStartupRateLimiters({
    hasTls,
    loopbackBind: isLoopbackBind(bindHost),
  });
  const trustedProxies = resolveTrustedProxies({ trustedProxies: config.auth?.trustedProxies });
  if (limits.rateLimiter || limits.principalLimiter) {
    console.error(
      `[drupal-mcp-connector] Rate limiting: ${limits.addressLimit} req / ${limits.windowSec}s `
      + `per client address (unauthenticated) and ${limits.principalLimit} req / ${limits.windowSec}s `
      + `per verified principal on /mcp. Trusted proxies: ${trustedProxies.length} (default trust none).`
    );
  }

  const opsListen = resolveOpsListen({ env: process.env, config });
  if (opsListen.fatal) {
    console.error(`[drupal-mcp-connector] FATAL: ${opsListen.reason}`);
    process.exit(1);
  }
  const metrics = createOpsMetrics({
    rateLimiter: limits.rateLimiter,
    principalLimiter: limits.principalLimiter,
  });

  const started = await startHttpsTransport(buildProductionHttpsOptions({
    bindHost,
    port: tlsCfg.port,
    allowHttp,
    allowUnauth,
    sharedToken: authToken,
    inboundCfg,
    tls: hasTls ? { certPath: tlsCfg.certPath, keyPath: tlsCfg.keyPath } : null,
    buildServer: buildConnectorServer,
    listenLabel: `${allDefinitions.length} tools · ${RESOURCES.length} resources · ${ALL_PROMPTS.length} prompts`,
    legacyMode: process.env.MCP_LEGACY_TRANSPORT || "serve",
    rateLimiter: limits.rateLimiter,
    principalLimiter: limits.principalLimiter,
    trustedProxies,
    metrics,
  }));

  if (started?.started && opsListen.enabled) {
    const ops = await startOpsListener({
      resolved: opsListen,
      metrics,
      readiness: {
        definitions: allDefinitions,
        sites: listResolvableSiteConfigs(),
        inboundCfg,
        loopbackBind: isLoopbackBind(bindHost),
      },
    });
    if (ops?.close) {
      const publicClose = started.close;
      started.close = async () => {
        await ops.close();
        await publicClose?.();
      };
    }
  }
  installHttpsShutdown(started);

} else {
  console.error(`[drupal-mcp-connector] Unknown MCP_TRANSPORT: "${transport}". Use "stdio", "https", or "http" (https alias).`);
  process.exit(1);
}
