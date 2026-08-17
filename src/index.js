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
 *   MCP_AUTH_TOKEN    Bearer token required on /mcp in https mode (warns if unset)
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

import { listSiteNames, getTlsConfig, CLIENT_VERSION } from "./lib/config.js";
import { loadLocalSecrets, secretLoadFatalMessage } from "./lib/load-secrets.js";
import { makeBearerCheck } from "./lib/http-auth.js";
import { createLegacySessionHandler, createMcpRequestHandler } from "./lib/http-handler.js";
import { createConnectorServerFactory } from "./lib/mcp-server.js";
import { createRateLimiter } from "./lib/rate-limit.js";
import { callTool, listResolvableSiteConfigs } from "./lib/dispatch.js";
import { filterDiscoverableTools } from "./lib/governance.js";

// Tools — aggregated (single source of truth, side-effect-free) and per-tool prompts
import { allDefinitions, allHandlers, definitionsByName } from "./tools/index.js";
import { buildToolPrompts, getToolPromptMessages } from "./lib/tool-prompts.js";

// Apply config/secrets.map (or the shipped example table) before any site
// resolution. MCP clients spawn this file directly; the shell launcher is
// not guaranteed to have run.
const secretLoad = loadLocalSecrets();
const secretFatal = secretLoadFatalMessage(secretLoad);
if (secretFatal) {
  console.error(`[drupal-mcp-connector] FATAL: ${secretFatal}`);
  process.exit(1);
}
if (secretLoad.unset.length) {
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
  // drupal://sites
  if (uri === "drupal://sites") {
    return { sites: listSiteNames() };
  }

  // drupal://{site}/content-types
  const ctMatch = uri.match(/^drupal:\/\/([^/]+)\/content-types$/);
  if (ctMatch) {
    return allHandlers.drupal_list_content_types({ site: ctMatch[1] });
  }

  // drupal://{site}/security-policy
  const spMatch = uri.match(/^drupal:\/\/([^/]+)\/security-policy$/);
  if (spMatch) {
    return allHandlers.drupal_security_info({ site: spMatch[1] });
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}

// ---------------------------------------------------------------------------
// MCP Prompts — common Drupal workflow templates
// ---------------------------------------------------------------------------

const PROMPTS = [
  {
    name:        "drupal-content-audit",
    description: "Walk through a full content audit: inventory, staleness, SEO gaps, accessibility issues, and recommendations.",
    arguments:   [{ name: "site", description: "Named site to audit (omit for default)", required: false }],
  },
  {
    name:        "drupal-create-article",
    description: "Guided workflow to research, draft, and publish an article node with all fields, tags, and metadata.",
    arguments:   [
      { name: "site",  description: "Target site",        required: false },
      { name: "topic", description: "Article topic/brief", required: true  },
    ],
  },
  {
    name:        "drupal-seo-fix",
    description: "Find SEO gaps in content (missing meta descriptions, thin content, title issues) and fix them interactively.",
    arguments:   [
      { name: "site", description: "Target site",         required: false },
      { name: "type", description: "Content type to scan", required: false },
    ],
  },
  {
    name:        "drupal-user-cleanup",
    description: "Identify inactive, never-logged-in, or overly permissioned user accounts and take action.",
    arguments:   [{ name: "site", description: "Target site", required: false }],
  },
  {
    name:        "drupal-full-audit",
    description: "Run a full site-health audit — content, link/404 integrity, and configuration posture — and turn the scored dashboard into a prioritized action plan.",
    arguments:   [
      { name: "site", description: "Named site to audit (omit for default)", required: false },
      { name: "type", description: "Primary content type to audit",          required: false },
    ],
  },
];

// Per-tool prompts: one slash-command prompt for every Drupal tool, derived from
// the tool definitions so the set always matches the tools. Merged after the
// hand-authored workflow prompts above (names never collide — workflow prompts use
// composite verbs, tool prompts mirror the `drupal_*` tool names).
const WORKFLOW_PROMPT_NAMES = new Set(PROMPTS.map((p) => p.name));
const TOOL_PROMPTS = buildToolPrompts(allDefinitions);
const ALL_PROMPTS  = [...PROMPTS, ...TOOL_PROMPTS];

/**
 * Build the message list for a named prompt, interpolating site/type/topic
 * args into a pre-authored multi-step workflow. Unknown prompt names fall back
 * to a generic one-line instruction so the call never fails.
 *
 * @param {string} name - The prompt name.
 * @param {object} args - Prompt arguments (site, type, topic — all optional).
 * @returns {Array<object>} MCP prompt messages.
 */
function getPromptMessages(name, args) {
  const site  = args?.site  ? `on the "${args.site}" site` : "on the default site";
  const type  = args?.type  || "article";
  const topic = args?.topic || "the requested topic";

  const prompts = {
    "drupal-content-audit": [
      { role: "user", content: { type: "text", text:
        `Please run a comprehensive content audit ${site}. Do not assume any particular content type exists — every site has a different model, so discover it first and audit the types this site actually has.\n` +
        "1. Call drupal_report_content_summary for the full inventory. Its byContentType list is the set of content types to audit — derive the types from it; never assume a fixed type such as \"article\".\n" +
        "2. For each content type that has nodes, call drupal_report_stale_content (days: 180).\n" +
        "3. For each content type that has nodes, call drupal_report_field_completeness.\n" +
        "4. For each content type with published nodes, check SEO: prefer drupal_report_seo_meta_coverage (it reads the site's actual meta field rather than assuming one) and use drupal_report_seo_audit for title-length and thin-content checks.\n" +
        "5. For each content type with published nodes, call drupal_report_accessibility_audit.\n" +
        "6. For any content type reporting zero nodes, skip its per-type scans and record it as empty — an empty type is not a clean one.\n" +
        "7. Synthesize findings into: (a) immediate actions, (b) medium-term improvements, (c) process recommendations.\n" +
        "Present results as a structured report with counts, severity, and specific node links where possible. State which content types were scanned so an empty or unexpected model cannot be mistaken for a clean audit."
      }},
    ],
    "drupal-create-article": [
      { role: "user", content: { type: "text", text:
        `I need to create a new article ${site} about: ${topic}\n\n` +
        "Please:\n" +
        "1. Call drupal_list_content_types to confirm \"article\" exists and check its fields.\n" +
        "2. Call drupal_get_entity_schema for node/article to see all available fields.\n" +
        "3. Call drupal_list_vocabularies and drupal_get_taxonomy_terms for relevant vocabularies.\n" +
        "4. Draft the article — title, body (well-structured HTML), summary, and meta description.\n" +
        "5. Suggest appropriate taxonomy tags.\n" +
        "6. Call drupal_create_node with status: false (draft) and show me the result.\n" +
        "7. Ask me to review before publishing."
      }},
    ],
    "drupal-seo-fix": [
      { role: "user", content: { type: "text", text:
        `Please find and fix SEO issues in "${type}" content ${site}.\n\n` +
        "1. Call drupal_report_seo_audit to identify all issues.\n" +
        "2. For nodes missing meta descriptions: generate appropriate descriptions (max 160 chars) and update them.\n" +
        "3. For thin content (under 300 words): flag for editorial review — do not auto-expand.\n" +
        "4. For title length issues: suggest better titles but ask before updating.\n" +
        "5. Report what was fixed, what needs human review, and any patterns you noticed."
      }},
    ],
    "drupal-user-cleanup": [
      { role: "user", content: { type: "text", text:
        `Please audit user accounts ${site} and recommend cleanup actions.\n\n` +
        "1. Call drupal_report_user_activity to identify inactive and never-logged-in accounts.\n" +
        "2. Call drupal_list_users with no filter to get the full list.\n" +
        "3. Call drupal_list_roles to see all available roles.\n" +
        "4. Identify: (a) accounts inactive 90+ days, (b) never-logged-in accounts, (c) accounts with admin roles that look like test/temp accounts.\n" +
        "5. For each category, recommend action (block, delete, or keep) with reasoning.\n" +
        "6. Ask for approval before making any changes."
      }},
    ],
    "drupal-full-audit": [
      { role: "user", content: { type: "text", text:
        `Please run a full site-health audit ${site} and turn it into a prioritized action plan.\n\n` +
        `1. Call drupal_audit_site_health (type: "${type}") for the scored dashboard and overall grade.\n` +
        "2. For any section reporting high-severity findings, drill in with the matching tool for detail:\n" +
        "   - links/404: drupal_report_404_log, drupal_report_redirect_health, drupal_report_broken_links (checkLive only with approval).\n" +
        "   - config: drupal_audit_config_best_practices, drupal_report_module_audit, drupal_report_permission_audit.\n" +
        "   - content: drupal_report_pii_exposure, drupal_report_duplicate_content, drupal_report_readability.\n" +
        "3. For sections reported 'unavailable', note what (server-tool bridge or drush) would enable them — do not treat unavailable as 'passing'.\n" +
        "4. Synthesize a prioritized plan: (a) high-severity/security fixes first, (b) content-quality improvements, (c) process recommendations.\n" +
        "5. Present counts, severity, and specific node/config references; propose redirects for the top 404s. Ask before making any changes."
      }},
    ],
  };

  return new Map(Object.entries(prompts)).get(name) ?? [{ role: "user", content: { type: "text", text: `Run the ${name} workflow ${site}.` } }];
}

// ---------------------------------------------------------------------------
// MCP Server surface — dispatch (middleware + callTool) lives in lib/dispatch.js
// ---------------------------------------------------------------------------

const buildConnectorServer = createConnectorServerFactory({
  serverInfo: { name: "drupal-mcp-connector", version: CLIENT_VERSION },
  tools: {
    definitions: allDefinitions,
    list: () => filterDiscoverableTools(allDefinitions, listResolvableSiteConfigs()),
    call: callTool,
  },
  resources: { definitions: RESOURCES, read: readResource },
  prompts: {
    definitions: ALL_PROMPTS,
    get: (name, args) => WORKFLOW_PROMPT_NAMES.has(name)
      ? getPromptMessages(name, args)
      : getToolPromptMessages(name, args, definitionsByName),
  },
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
  const checkAuth   = makeBearerCheck(authToken);
  const allowUnauth = process.env.MCP_ALLOW_UNAUTHENTICATED === "1";
  if (!authToken) {
    console.error(
      "[drupal-mcp-connector] WARNING: the /mcp endpoint is UNAUTHENTICATED. " +
      "Set MCP_AUTH_TOKEN to require a bearer token, or front it with a trusted " +
      "boundary (private network / auth proxy). Acceptable only behind such a boundary."
    );
  }

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

  // #141: fail closed when HTTPS is network-facing without a bearer token.
  // Loopback binds and explicit MCP_ALLOW_UNAUTHENTICATED=1 remain for local/proxy setups.
  if (!authToken && !isLoopbackBind && !allowUnauth) {
    console.error(
      "[drupal-mcp-connector] FATAL: MCP_AUTH_TOKEN is required when binding beyond loopback.\n" +
      "  Set MCP_AUTH_TOKEN, bind to 127.0.0.1 (default without MCP_BIND_HOST), or set\n" +
      "  MCP_ALLOW_UNAUTHENTICATED=1 only behind a trusted auth boundary."
    );
    process.exit(1);
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
