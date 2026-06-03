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
 */

import { createServer as createHttpsServer } from "https";
import { createServer as createHttpServer }  from "http";
import { readFileSync }                      from "fs";
import { randomUUID }                        from "node:crypto";

import { Server }                   from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport }     from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema }   from "@modelcontextprotocol/sdk/types.js";

import { getSiteConfig, listSiteNames, getTlsConfig } from "./lib/config.js";
import { makeBearerCheck } from "./lib/http-auth.js";
import { resolveSecurityConfig, assertNotReadOnly,
  assertDestructiveAllowed, assertGraphqlMutationAllowed,
  SecurityError }            from "./lib/security.js";
import { toolError, toolResult }    from "./lib/errors.js";
import { BackendCapabilityError, BackendResolutionError } from "./lib/backends/errors.js";

// Tool modules
import * as nodes    from "./tools/nodes.js";
import * as taxonomy from "./tools/taxonomy.js";
import * as users    from "./tools/users.js";
import * as media    from "./tools/media.js";
import * as graphql  from "./tools/graphql.js";
import * as site     from "./tools/site.js";
import * as entities from "./tools/entities.js";
import * as reports  from "./tools/reports.js";
import * as drush    from "./tools/drush.js";

// ---------------------------------------------------------------------------
// Aggregate tools
// ---------------------------------------------------------------------------

const allModules = [nodes, taxonomy, users, media, graphql, site, entities, reports, drush];

// Flatten every module's tool definitions into one ListTools payload, and merge
// their handler maps into a single closed dispatch table keyed by tool name.
const allDefinitions = allModules.flatMap((m) => m.definitions);
const allHandlers    = Object.assign({}, ...allModules.map((m) => m.handlers));

// ---------------------------------------------------------------------------
// Security middleware — runs BEFORE every tool handler
//
// Operation intent (read/write/delete/graphql) is inferred from the tool name
// prefix rather than trusting per-tool metadata, so a new tool that follows the
// naming convention is gated automatically. The matched operation drives which
// assertions from lib/security.js run against the resolved per-site policy.
// ---------------------------------------------------------------------------

const WRITE_PREFIXES       = ["drupal_create_", "drupal_update_", "drupal_upload_",
  "drupal_block_",  "drupal_drush_cache", "drupal_drush_cron",
  "drupal_drush_config_export", "drupal_drush_config_import",
  "drupal_drush_updatedb", "drupal_drush_module_enable",
  "drupal_drush_module_disable", "drupal_drush_user_create"];
const DESTRUCTIVE_PREFIXES = ["drupal_delete_", "drupal_drush_module_disable"];

/**
 * Classify a tool's operation intent from its name prefix.
 *
 * @param {string} toolName - The MCP tool name being invoked.
 * @returns {"delete"|"write"|"graphql"|"read"} Inferred operation. Destructive
 *   prefixes are checked first so they take precedence over plain write.
 */
function inferOperation(toolName) {
  if (DESTRUCTIVE_PREFIXES.some((p) => toolName.startsWith(p))) return "delete";
  if (WRITE_PREFIXES.some((p) => toolName.startsWith(p)))       return "write";
  if (toolName === "drupal_graphql")                             return "graphql";
  return "read";
}

/**
 * Derive the entity type a tool acts on, for destructive-allow assertions.
 *
 * @param {string} toolName - The MCP tool name.
 * @param {object} args     - The tool arguments.
 * @returns {string} Explicit args.entityType when present, else the suffix
 *   parsed from the tool name (e.g. "node" from "drupal_delete_node"),
 *   falling back to "entity".
 */
function extractEntityType(toolName, args) {
  if (args?.entityType) return args.entityType;
  const m = toolName.match(/^drupal_(?:delete|create|update|get|list)_(.+)$/);
  return m ? m[1] : "entity";
}

/**
 * Apply per-site security assertions before dispatching to a tool handler.
 *
 * @param {string}   toolName - The MCP tool name.
 * @param {object}   args     - Tool arguments (may carry `site`, `id`, etc.).
 * @param {Function} handler  - The resolved tool handler.
 * @returns {Promise<*>} The handler's result.
 * @throws {SecurityError} If the resolved policy forbids the inferred operation.
 */
async function securityMiddleware(toolName, args, handler) {
  // Tools with no site context skip per-site checks
  if (toolName === "drupal_list_sites") return handler(args);

  const site = getSiteConfig(args?.site);
  const sec  = resolveSecurityConfig(site);
  const op   = inferOperation(toolName);

  if (op === "delete") {
    assertDestructiveAllowed(sec, extractEntityType(toolName, args), args?.id ?? "?");
    assertNotReadOnly(sec, toolName);
  } else if (op === "write") {
    assertNotReadOnly(sec, toolName);
  } else if (op === "graphql" && args?.query) {
    assertGraphqlMutationAllowed(sec, args.query);
  }

  return handler(args);
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
];

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
        `Please run a comprehensive content audit ${site}. Follow these steps:\n` +
        "1. Call drupal_report_content_summary to get the full inventory.\n" +
        "2. Call drupal_report_stale_content (days: 180) to find stale content.\n" +
        "3. Call drupal_report_field_completeness for each major content type.\n" +
        "4. Call drupal_report_seo_audit for the article content type.\n" +
        "5. Call drupal_report_accessibility_audit for the article content type.\n" +
        "6. Synthesize findings into: (a) immediate actions, (b) medium-term improvements, (c) process recommendations.\n" +
        "Present results as a structured report with counts, severity, and specific node links where possible."
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
  };

  return new Map(Object.entries(prompts)).get(name) ?? [{ role: "user", content: { type: "text", text: `Run the ${name} workflow ${site}.` } }];
}

// ---------------------------------------------------------------------------
// MCP Server construction
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "drupal-mcp-connector", version: "0.6.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// Tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allDefinitions }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // eslint-disable-next-line security/detect-object-injection -- name is an MCP tool name from validated schema; allHandlers is a closed dispatch table built at startup
  const handler = allHandlers[name];

  if (!handler) {
    return toolError(new Error(
      `Unknown tool "${name}". Call drupal_list_entity_types to discover available resources.`
    ));
  }

  try {
    const result = await securityMiddleware(name, args ?? {}, handler);
    return toolResult(result);
  } catch (err) {
    // Translate known error classes into clear, non-leaky isError responses;
    // anything else falls through to toolError for a generic envelope.
    if (err instanceof SecurityError) {
      return { content: [{ type: "text", text: `Access denied: ${err.message}` }], isError: true };
    }
    if (err instanceof BackendCapabilityError) {
      return { content: [{ type: "text", text: `Not supported by this site's backend: ${err.message}` }], isError: true };
    }
    if (err instanceof BackendResolutionError) {
      return { content: [{ type: "text", text: `Backend resolution failed: ${err.message}` }], isError: true };
    }
    return toolError(err);
  }
});

// Resources
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  try {
    const data = await readResource(uri);
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    throw new Error(`Resource read failed (${uri}): ${err.message}`);
  }
});

// Prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const known = PROMPTS.find((p) => p.name === name);
  if (!known) throw new Error(`Unknown prompt: "${name}"`);
  return { description: known.description, messages: getPromptMessages(name, args) };
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const transport = process.env.MCP_TRANSPORT || "stdio";

if (transport === "stdio") {
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error(
    "[drupal-mcp-connector v0.6.0] stdio transport active. " +
    `${allDefinitions.length} tools · ${RESOURCES.length} resources · ${PROMPTS.length} prompts`
  );

} else if (transport === "https" || transport === "http") {

  // Dynamically import the HTTP transport — only needed in server mode
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const tlsCfg     = getTlsConfig();
  const port       = tlsCfg.port;
  const allowHttp  = process.env.MCP_ALLOW_HTTP === "1";

  const authToken   = process.env.MCP_AUTH_TOKEN || "";
  const checkAuth   = makeBearerCheck(authToken);
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

  // Map of sessionId → transport for multi-client support
  const sessions = new Map();

  const nodeServer = createNodeServer(async (req, res) => {
    if (req.url === "/mcp" && (req.method === "POST" || req.method === "GET")) {
      if (!checkAuth(req.headers["authorization"])) {
        res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
        return;
      }
    }

    if (req.method === "POST" && req.url === "/mcp") {
      const sessionId = req.headers["mcp-session-id"];
      let mcpTransport;

      if (sessionId && sessions.has(sessionId)) {
        mcpTransport = sessions.get(sessionId);
      } else {
        mcpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => sessions.set(id, mcpTransport),
        });
        mcpTransport.onclose = () => sessions.delete(mcpTransport.sessionId);
        await server.connect(mcpTransport);
      }
      await mcpTransport.handleRequest(req, res);

    } else if (req.method === "GET" && req.url === "/mcp") {
      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400).end("Missing or unknown MCP-Session-Id");
        return;
      }
      await sessions.get(sessionId).handleRequest(req, res);

    } else if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: "ok", tools: allDefinitions.length }));

    } else {
      res.writeHead(404).end("Not found");
    }
  });

  const hasTls   = Boolean(tlsCfg.certPath && tlsCfg.keyPath);
  // Unauthenticated plain HTTP must never bind beyond loopback. A non-loopback
  // bind is allowed only alongside TLS, via an explicit MCP_BIND_HOST opt-in.
  const bindHost = hasTls ? (process.env.MCP_BIND_HOST || "0.0.0.0") : "127.0.0.1";

  nodeServer.listen(port, bindHost, () => {
    const proto = hasTls ? "https" : "http";
    console.error(
      `[drupal-mcp-connector v0.6.0] Listening on ${proto}://${bindHost}:${port}/mcp\n` +
      `  ${allDefinitions.length} tools · ${RESOURCES.length} resources · ${PROMPTS.length} prompts`
    );
  });

} else {
  console.error(`[drupal-mcp-connector] Unknown MCP_TRANSPORT: "${transport}". Use "stdio" or "https".`);
  process.exit(1);
}
