#!/usr/bin/env node
/**
 * drupal-mcp-edge — relay northbound edge entry point (#232).
 *
 * Terminates northbound MCP on the inbound OAuth resource server and fans
 * requests down the outbound tenant-agent channel (see src/lib/relay/edge.js).
 * There is no shared-bearer and no unauthenticated mode on this entry point:
 * MCP_AUTH_TOKEN and MCP_ALLOW_UNAUTHENTICATED are ignored, and a missing
 * issuer/audience is fatal at every bind host including loopback. The edge
 * holds no site credentials; its site catalog is names and base URLs only.
 *
 * Environment variables:
 *   MCP_RESOURCE_ISSUER / MCP_RESOURCE_AUDIENCE / MCP_RESOURCE
 *                     Inbound OAuth resource server (or config auth.issuer /
 *                     auth.audience / auth.resource). Required.
 *   MCP_CHANNEL_CREDENTIALS_FILE
 *                     Agent channel credential store (or config
 *                     relay.channelCredentialsFile). Required. JSON:
 *                     {"agents": {"<id>": {"tokenSha256": "<hex>",
 *                     "sites": ["site-name"]}}}. `sites` binds the tunnel
 *                     to catalog names (the tenant boundary). Omit `sites`
 *                     only for a single-agent install.
 *   MCP_EDGE_PORT     Northbound port (default: MCP_PORT / config tls.port).
 *   MCP_EDGE_AGENT_PORT
 *                     Agent channel port (default: northbound port + 1).
 *   MCP_BIND_HOST     Northbound bind when TLS is present (default 0.0.0.0).
 *   MCP_EDGE_AGENT_BIND_HOST
 *                     Agent channel bind (default: the northbound bind).
 *   TLS_CERT_PATH / TLS_KEY_PATH
 *                     TLS material for both listeners.
 *   MCP_ALLOW_HTTP    "1" permits plain loopback listeners (dev only).
 *   MCP_RATE_LIMIT / MCP_RATE_WINDOW_SEC
 *                     Northbound /mcp rate limit (same defaults as the
 *                     primary entry point).
 *   MCP_EDGE_USAGE_MAX_RECORDS
 *                     Positive integer enables the in-process usage ledger
 *                     (or config relay.usage.maxRecords). Every decision and
 *                     receipt is recorded per tenant and principal, and
 *                     GET /usage serves the caller's own tenant partition.
 *                     Unset: nothing is recorded and /usage is 404.
 *
 * Config: auth.grants (client id -> [site names]) is mandatory; the edge
 * refuses to start without it. Optional auth.tenantGrants (client id ->
 * [tenant agent ids]) makes tenant routing grant-authoritative. Optional
 * auth.actors (sub / azp -> Drupal user UUID) maps the inbound principal
 * to a Drupal actor for write-like tools. Optional auth.policies
 * (sub / azp -> SHA-256 digest) is the expected signed policy on the edge.
 * Optional auth.promotions (digest -> sealed document + two operator ids)
 * is the W&L-operated dual-control ledger; the edge fans eligible bundles
 * to the tenant agent and requires a matching local attestation. Optional
 * auth.quotas (tenant / principal request windows plus an abuse lock)
 * fails closed at the edge with zero frames on any refusal.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import {
  getInboundActors,
  getInboundGrants,
  getInboundPolicies,
  getInboundPromotions,
  getInboundQuotas,
  getInboundTenantGrants,
  getTlsConfig,
  loadConfig,
} from "../src/lib/config.js";
import { resolveInboundAuthConfig } from "../src/lib/http-auth.js";
import { createRateLimiter } from "../src/lib/rate-limit.js";
import { createUsageLedger } from "../src/lib/usage.js";
import {
  createChannelCredentialStore,
  startEdge,
} from "../src/lib/relay/edge.js";

function fatal(message) {
  console.error(`[drupal-mcp-edge] FATAL: ${message}`);
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch (error) {
  fatal(error instanceof Error ? error.message : "configuration load failed");
}

const inboundCfg = resolveInboundAuthConfig(config);
if (!inboundCfg.issuer || !inboundCfg.audience) {
  fatal(
    "The relay edge requires an inbound OAuth resource server: set auth.issuer and "
    + "auth.audience (or MCP_RESOURCE_ISSUER / MCP_RESOURCE_AUDIENCE). There is no "
    + "shared-bearer or unauthenticated mode on this entry point, at any bind host "
    + "including loopback.",
  );
}

const grants = getInboundGrants();
if (!grants) {
  fatal(
    "The relay edge refuses to start without a non-empty auth.grants table "
    + "(client id -> [site names]).",
  );
}

const channelFile = process.env.MCP_CHANNEL_CREDENTIALS_FILE
  || config.relay?.channelCredentialsFile
  || "";
if (!channelFile) {
  fatal(
    "The relay edge requires an agent channel credential store: set "
    + "MCP_CHANNEL_CREDENTIALS_FILE (or relay.channelCredentialsFile).",
  );
}

// The catalog is passed as configured; startEdge refuses any entry carrying
// credential material, so a tenant config deployed to an edge host fails
// closed instead of quietly holding site secrets.
const sites = Object.entries(config.sites ?? {})
  .map(([name, site]) => ({ _name: name, ...site }));

const tlsCfg = getTlsConfig();
let tls = null;
if (tlsCfg.certPath && tlsCfg.keyPath) {
  tls = {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- TLS cert/key path comes from operator-controlled config, not user input
    cert: readFileSync(tlsCfg.certPath),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- TLS cert/key path comes from operator-controlled config, not user input
    key: readFileSync(tlsCfg.keyPath),
  };
}
const allowHttp = process.env.MCP_ALLOW_HTTP === "1";
const bindHost = tls ? (process.env.MCP_BIND_HOST || "0.0.0.0") : "127.0.0.1";
const agentBindHost = process.env.MCP_EDGE_AGENT_BIND_HOST || bindHost;
const isLoopbackBind = bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";

const port = Number(process.env.MCP_EDGE_PORT || tlsCfg.port);
const agentPort = Number(process.env.MCP_EDGE_AGENT_PORT || port + 1);

// Northbound rate limiting, same defaults as the primary entry point (#141).
const rateWindowSec = Number(process.env.MCP_RATE_WINDOW_SEC || 60);
const rateLimitEnv = process.env.MCP_RATE_LIMIT;
const rateLimitDefault = (tls && !isLoopbackBind) ? 120 : 0;
const rateLimit = rateLimitEnv === undefined || rateLimitEnv === ""
  ? rateLimitDefault
  : Number(rateLimitEnv);

// Usage ledger (#256): opt-in, in-process, bounded. A restart clears it.
const usageMaxRecords = Number(
  process.env.MCP_EDGE_USAGE_MAX_RECORDS || config.relay?.usage?.maxRecords || 0,
);
const usage = Number.isInteger(usageMaxRecords) && usageMaxRecords > 0
  ? createUsageLedger({ maxRecords: usageMaxRecords })
  : null;
const quotas = getInboundQuotas();

let edge;
try {
  edge = await startEdge({
    auth: inboundCfg,
    grants,
    tenantGrants: getInboundTenantGrants(),
    actors: getInboundActors(),
    policies: getInboundPolicies(),
    promotions: getInboundPromotions(),
    quotas,
    usage,
    sites,
    defaultSite: config.defaultSite,
    channelCredentials: createChannelCredentialStore({ filePath: channelFile }),
    bindHost,
    agentBindHost,
    port,
    agentPort,
    tls,
    allowHttpLoopback: allowHttp,
    rateLimiter: rateLimit > 0
      ? createRateLimiter({ limit: rateLimit, windowMs: rateWindowSec * 1000 })
      : null,
  });
} catch (error) {
  fatal(error instanceof Error ? error.message : "edge startup failed");
}

console.error(
  `[drupal-mcp-edge] Northbound ${edge.northboundUrl} · `
  + `agent channel ${agentBindHost}:${edge.agentPort} · `
  + `issuer ${inboundCfg.issuer}`,
);
if (rateLimit > 0) {
  console.error(
    `[drupal-mcp-edge] Rate limiting: ${rateLimit} req / ${rateWindowSec}s per client IP on /mcp.`,
  );
}
if (usage) {
  console.error(
    `[drupal-mcp-edge] Usage ledger: in-process, ${usageMaxRecords} records max; GET /usage serves one tenant partition.`,
  );
}
if (quotas) {
  console.error("[drupal-mcp-edge] Quotas: auth.quotas in force; unlisted tenants / principals are refused.");
}
