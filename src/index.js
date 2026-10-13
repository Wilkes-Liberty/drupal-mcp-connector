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
 *   MCP_AUTH_TOKEN    Removed in 4.0.0 (#231); setting it is fatal at startup
 *   MCP_RESOURCE_ISSUER / MCP_RESOURCE_AUDIENCE / MCP_RESOURCE
 *                     Inbound OAuth resource-server (required beyond loopback)
 *   MCP_BIND_HOST     Bind address for https mode when TLS is present
 *                     (default: "0.0.0.0"; ignored without TLS, which forces loopback)
 *   MCP_RATE_LIMIT    Max /mcp requests per window per client IP (0/unset = off)
 *   MCP_RATE_WINDOW_SEC  Rate-limit window in seconds (default: 60)
 *   MCP_LEGACY_TRANSPORT "serve" (default) | "reject" for 2025-era clients
 *   MCP_ALLOWED_ORIGINS Comma/space-separated Origin allowlist (DNS-rebinding);
 *                     a present empty value clears the configured list
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
import { createStartupRateLimiter, startHttpsTransport } from "./lib/https-startup.js";
import { createConnectorServerFactory } from "./lib/mcp-server.js";
import { callTool, invokeReadTool, listResolvableSiteConfigs } from "./lib/dispatch.js";
import { fetchTextFormatContext, installTextFormatContextFetcher } from "./lib/text-format-context.js";
import { filterDiscoverableTools } from "./lib/governance.js";
import {
  filterPromptsByPrincipal,
  filterResourcesByPrincipal,
  filterToolsByPrincipal,
  getRequestIdentity,
  visibleSiteTargets,
} from "./lib/principal.js";

// Tools — aggregated (single source of truth, side-effect-free) and per-tool prompts
import { allDefinitions, definitionsByName } from "./tools/index.js";
import { createModuleToolRegistry, isModuleTool } from "./lib/module-tools.js";
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
        await moduleWorkflowProvidersWithRemote(listResolvableSiteConfigs()),
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
  const allowHttp  = process.env.MCP_ALLOW_HTTP === "1";
  const authToken   = process.env.MCP_AUTH_TOKEN || "";
  const allowUnauth = process.env.MCP_ALLOW_UNAUTHENTICATED === "1";
  const hasTls   = Boolean(tlsCfg.certPath && tlsCfg.keyPath);
  // Unauthenticated plain HTTP must never bind beyond loopback. A non-loopback
  // bind is allowed only alongside TLS, via an explicit MCP_BIND_HOST opt-in.
  const bindHost = hasTls ? (process.env.MCP_BIND_HOST || "0.0.0.0") : "127.0.0.1";
  const inboundCfg = resolveInboundAuthConfig(loadConfig());
  const rateLimiter = createStartupRateLimiter({
    hasTls,
    loopbackBind: isLoopbackBind(bindHost),
  });
  if (rateLimiter) {
    console.error(
      `[drupal-mcp-connector] Rate limiting: ${rateLimiter.limit} req / ${rateLimiter.windowSec}s per client IP on /mcp.`,
    );
  }

  await startHttpsTransport({
    bindHost,
    port: tlsCfg.port,
    allowHttp,
    allowUnauth,
    sharedToken: authToken,
    inboundCfg,
    tls: hasTls ? { certPath: tlsCfg.certPath, keyPath: tlsCfg.keyPath } : null,
    buildServer: buildConnectorServer,
    toolCount: allDefinitions.length,
    listenLabel: `${allDefinitions.length} tools · ${RESOURCES.length} resources · ${ALL_PROMPTS.length} prompts`,
    legacyMode: process.env.MCP_LEGACY_TRANSPORT || "serve",
    rateLimiter,
  });

} else {
  console.error(`[drupal-mcp-connector] Unknown MCP_TRANSPORT: "${transport}". Use "stdio" or "https".`);
  process.exit(1);
}
