#!/usr/bin/env node
/**
 * drupal-mcp-agent — relay tenant agent entry point (#232).
 *
 * Dials OUT to the relay edge's agent channel and serves the real connector
 * server (the full governed tool surface, dispatched through the same
 * middleware as every other transport) over the framed tunnel. This process
 * never listens: southbound site credentials exist only here, tenant-side.
 * The channel is authenticated with the agent's own issued, revocable
 * credential — never a northbound token, never a site credential.
 *
 * Environment variables:
 *   MCP_EDGE_HOST         Relay edge host. Required.
 *   MCP_EDGE_AGENT_PORT   Relay edge agent-channel port. Required.
 *   MCP_CHANNEL_TOKEN     Issued channel credential (or MCP_CHANNEL_TOKEN_FILE).
 *                         Required. The edge stores only its SHA-256 digest.
 *   MCP_EDGE_ALLOW_TCP    "1" permits a plain TCP channel to loopback only
 *                         (dev). The default channel is TLS.
 *
 * On a lost channel the process exits non-zero — fail loudly and let the
 * supervisor restart it rather than idling disconnected.
 */

import { readFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import process from "node:process";
import { CLIENT_VERSION, listSiteNames, loadConfig } from "../src/lib/config.js";
import { callTool, listResolvableSiteConfigs } from "../src/lib/dispatch.js";
import { filterDiscoverableTools } from "../src/lib/governance.js";
import {
  loadLocalSecrets,
  secretLoadFatalMessage,
  secretTableMismatchMessage,
} from "../src/lib/load-secrets.js";
import {
  filterPromptsByPrincipal,
  filterResourcesByPrincipal,
  filterToolsByPrincipal,
  getRequestIdentity,
  visibleSiteTargets,
} from "../src/lib/principal.js";
import { createRelayAgent } from "../src/lib/relay/agent.js";
import { buildToolPrompts, getToolPromptMessages } from "../src/lib/tool-prompts.js";
import { allDefinitions, definitionsByName } from "../src/tools/index.js";

function fatal(message) {
  console.error(`[drupal-mcp-agent] FATAL: ${message}`);
  process.exit(1);
}

const host = process.env.MCP_EDGE_HOST || "";
const port = Number(process.env.MCP_EDGE_AGENT_PORT || 0);
if (!host || !port) {
  fatal("Set MCP_EDGE_HOST and MCP_EDGE_AGENT_PORT to the relay edge's agent channel.");
}

const tokenFile = process.env.MCP_CHANNEL_TOKEN_FILE || "";
const token = process.env.MCP_CHANNEL_TOKEN
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- credential path comes from the operator's environment, not user input
  || (tokenFile ? readFileSync(tokenFile, "utf8").trim() : "");
if (!token) {
  fatal(
    "The tenant agent requires its issued channel credential: set "
    + "MCP_CHANNEL_TOKEN or MCP_CHANNEL_TOKEN_FILE.",
  );
}

// Apply config/secrets.map before any site resolution, exactly like the
// primary entry point: this process is where site credentials live.
const secretLoad = loadLocalSecrets();
const secretFatal = secretLoadFatalMessage(secretLoad);
if (secretFatal) fatal(secretFatal);
const secretMismatch = secretTableMismatchMessage(secretLoad);
if (secretMismatch) {
  console.error(`[drupal-mcp-agent] WARNING: ${secretMismatch}`);
} else if (secretLoad.unset.length) {
  console.error(
    "[drupal-mcp-agent] WARNING: config.json names secret env vars that are unset: "
    + `${secretLoad.unset.join(", ")}. Those sites will fail closed.`,
  );
}

try {
  loadConfig();
} catch (error) {
  fatal(error instanceof Error ? error.message : "configuration load failed");
}

// ---------------------------------------------------------------------------
// Connector surface — the real governed tool surface. Workflow prompts and
// the templated resources stay on the primary entry point; the governed
// surface here is tools (full), the sites resource, and per-tool prompts.
// ---------------------------------------------------------------------------

const RESOURCES = [{
  uri: "drupal://sites",
  name: "Configured Drupal Sites",
  description: "All named Drupal site profiles (no credentials).",
  mimeType: "application/json",
}];

const TOOL_PROMPTS = buildToolPrompts(allDefinitions);

async function discoverableTools() {
  const sites = listResolvableSiteConfigs();
  const identity = getRequestIdentity();
  const governed = await filterDiscoverableTools(allDefinitions, sites);
  return filterToolsByPrincipal(governed, sites, identity);
}

const surface = {
  serverInfo: { name: "drupal-mcp-connector", version: CLIENT_VERSION },
  tools: {
    definitions: allDefinitions,
    list: discoverableTools,
    call: callTool,
  },
  resources: {
    definitions: RESOURCES,
    list: async () => {
      const sites = listResolvableSiteConfigs();
      return filterResourcesByPrincipal(RESOURCES, getRequestIdentity(), sites);
    },
    read: async (uri) => {
      if (uri === "drupal://sites") {
        return visibleSiteTargets(
          getRequestIdentity(),
          listResolvableSiteConfigs(),
          listSiteNames(),
        );
      }
      throw new Error(`Unknown resource URI: ${uri}`);
    },
  },
  prompts: {
    definitions: TOOL_PROMPTS,
    list: async () => {
      const identity = getRequestIdentity();
      const tools = await discoverableTools();
      return filterPromptsByPrincipal(TOOL_PROMPTS, identity, tools);
    },
    get: (name, args) => getToolPromptMessages(name, args, definitionsByName),
  },
};

// ---------------------------------------------------------------------------
// Channel — TLS by default; plain TCP only to loopback, by explicit opt-in.
// ---------------------------------------------------------------------------

const allowTcp = process.env.MCP_EDGE_ALLOW_TCP === "1";
const isLoopbackEdge = host === "127.0.0.1" || host === "::1" || host === "localhost";
let connectFn;
if (allowTcp) {
  if (!isLoopbackEdge) {
    fatal("MCP_EDGE_ALLOW_TCP permits a plain channel to loopback only. Use TLS.");
  }
  connectFn = netConnect;
} else {
  connectFn = (options, onConnect) =>
    tlsConnect({ ...options, servername: host }, onConnect);
}

const agent = createRelayAgent({
  host,
  port,
  token,
  surface,
  connectFn,
  onChannelClose: () => {
    fatal("The channel to the relay edge was lost. Exiting for a supervised restart.");
  },
});

let hello;
try {
  hello = await agent.dial();
} catch (error) {
  fatal(`Could not dial the relay edge at ${host}:${port}: `
    + `${error instanceof Error ? error.message : "unknown error"}`);
}
if (!hello.ok) {
  fatal(`The relay edge denied the channel credential (${hello.reason}).`);
}

console.error(
  `[drupal-mcp-agent v${CLIENT_VERSION}] Outbound channel to ${host}:${port} `
  + `established as "${hello.agent?.agentId ?? "unknown"}" · `
  + `${allDefinitions.length} tools · ${RESOURCES.length} resources · `
  + `${TOOL_PROMPTS.length} prompts`,
);
