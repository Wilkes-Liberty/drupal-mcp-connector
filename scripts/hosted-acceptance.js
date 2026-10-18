#!/usr/bin/env node
/**
 * Hosted MCP acceptance probe (DEV-817 / DEV-953).
 *
 * Read-only checks against the live staging and production Streamable HTTP
 * endpoints, plus the advertised Paladin issuer. Proves discovery, Origin
 * allow/deny, authorization-request accept/reject, closed dynamic client
 * registration, and (when the operator supplies a token) initialize /
 * tools/list / one read-only tools/call.
 *
 * Tokens, client secrets, cookies, and tool payloads never reach stdout,
 * stderr, or the JSON report. Timestamps are America/New_York.
 *
 *   npm run eval:hosted
 *   npm run eval:hosted -- --require-signed-in
 *   HOSTED_MCP_TOKEN=… npm run eval:hosted -- --host staging
 */

import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  CURSOR_BROWSER_ORIGIN,
  CURSOR_WWW_BROWSER_ORIGIN,
  GROK_BOT_BROWSER_ORIGIN,
  GROK_BOT_CONSOLE_ORIGIN,
  HOSTED_PUBLIC_CLIENT_ORIGINS,
} from "../src/lib/http-transport.js";
import { isWriteLikeTool } from "../src/lib/operations.js";

/** Default hosted MCP planes the operator asked this probe to cover. */
export const DEFAULT_HOSTS = Object.freeze([
  Object.freeze({
    id: "staging",
    origin: "https://mcp.staging.wilkesliberty.com",
    mcpUrl: "https://mcp.staging.wilkesliberty.com/mcp",
  }),
  Object.freeze({
    id: "production",
    origin: "https://mcp.wilkesliberty.com",
    mcpUrl: "https://mcp.wilkesliberty.com/mcp",
  }),
]);

/** Shared Paladin realm advertised by both hosted protected-resource documents. */
export const ISSUER = "https://auth.wilkesliberty.com/realms/wilkesliberty";

/** Published Grok Bot client ID metadata document (CIMD). */
export const GROK_CIMD_URL = "https://grok.com/oauth/mcp-client.json";

/** Published Claude Code client ID metadata document (CIMD). */
export const CLAUDE_CIMD_URL = "https://claude.ai/oauth/claude-code-client-metadata";

/** Claude hosted-app OAuth callback (not a provisioned realm client). */
export const CLAUDE_HOSTED_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** Cursor public PKCE client from keystone#1539. */
export const CURSOR_CLIENT_ID = "cursor-mcp";

/** Grok Bot public PKCE client from keystone#1539. Short name, not the CIMD URL. */
export const GROK_CLIENT_ID = "grok-bot";

/** Documented read-only tool used by the Paladin smoke on DEV-817. */
export const READ_TOOL = "drupal_list_content_types";

const MCP_PROTOCOL = "2026-07-28";
const ACCEPT = "application/json, text/event-stream";
const ET = "America/New_York";

/**
 * Per-client OAuth facts this probe asserts. Origins match
 * {@link HOSTED_PUBLIC_CLIENT_ORIGINS}. Redirects are the live realm lists
 * observed 2026-10-18 (cursor-mcp + grok-bot, including the Cursor callbacks
 * on grok-bot from keystone#1531).
 *
 * @type {readonly object[]}
 */
export const CLIENT_PATHS = Object.freeze([
  Object.freeze({
    id: "cursor",
    name: "Cursor",
    clientId: CURSOR_CLIENT_ID,
    registration: "pre-registered-public-pkce",
    pkce: "S256",
    scopes: Object.freeze(["mcp_read"]),
    origins: Object.freeze([CURSOR_BROWSER_ORIGIN, CURSOR_WWW_BROWSER_ORIGIN]),
    acceptRedirects: Object.freeze([
      "https://www.cursor.com/agents/mcp/oauth/callback",
      "http://localhost:8787/callback",
    ]),
    rejectRedirects: Object.freeze([
      "https://cursor.com/agents/mcp/oauth/callback",
      "https://evil.example/callback",
    ]),
  }),
  Object.freeze({
    id: "grok",
    name: "Grok Bot",
    clientId: GROK_CLIENT_ID,
    cimdUrl: GROK_CIMD_URL,
    registration: "pre-registered-public-pkce",
    pkce: "S256",
    scopes: Object.freeze(["mcp_read"]),
    origins: Object.freeze([GROK_BOT_BROWSER_ORIGIN, GROK_BOT_CONSOLE_ORIGIN]),
    acceptRedirects: Object.freeze([
      "https://grok.com/connectors-oauth-exchange-code/",
      "https://console.x.ai/connectors-oauth-exchange-code/",
      "https://www.cursor.com/agents/mcp/oauth/callback",
    ]),
    rejectRedirects: Object.freeze(["https://evil.example/callback"]),
    cimdClientId: GROK_CIMD_URL,
    cimdClientIdExpect: "client_not_found",
  }),
  Object.freeze({
    id: "claude",
    name: "Claude",
    clientId: "claude",
    cimdUrl: CLAUDE_CIMD_URL,
    registration: "not-provisioned",
    pkce: "S256",
    scopes: Object.freeze(["mcp_read"]),
    origins: Object.freeze(["https://claude.ai"]),
    originExpect: "refuse",
    acceptRedirects: Object.freeze([]),
    rejectRedirects: Object.freeze([CLAUDE_HOSTED_REDIRECT]),
    unknownClientExpect: "client_not_found",
  }),
]);

const FOREIGN_ORIGINS = Object.freeze([
  "https://evil.example",
  "https://cursor.com.evil.example",
  "https://claude.ai",
]);

export const SECRET_ENV = Object.freeze([
  "HOSTED_MCP_TOKEN",
  "HOSTED_MCP_TOKEN_STAGING",
  "HOSTED_MCP_TOKEN_PRODUCTION",
  "HOSTED_MCP_TOKEN_WRONG_AUDIENCE",
  "HOSTED_MCP_TOKEN_EXPIRED",
  "HOSTED_MCP_TOKEN_INSUFFICIENT_SCOPE",
  "HOSTED_MCP_CLIENT_SECRET",
  "EVAL_HTTP_STAGING_TOKEN_READ",
  "EVAL_HTTP_STAGING_TOKEN_WRONG_AUDIENCE",
  "EVAL_HTTP_STAGING_TOKEN_EXPIRED",
  "EVAL_HTTP_STAGING_TOKEN_INSUFFICIENT_SCOPE",
]);

/**
 * Format `date` in America/New_York (ET).
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function formatEt(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")} ${pick("timeZoneName")}`;
}

const SECRET_PATTERN = /(?:bearer\s+eyJ[a-zA-Z0-9._~+/-]+=*|bearer\s+[a-zA-Z0-9._~+/=-]{24,}=*|client_secret(?:=|(?:\s*[:\"']\s*))\S+|eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/gi;

/**
 * Strip bearer tokens, JWT-shaped strings, and client_secret assignments.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecrets(value) {
  return String(value ?? "").replace(SECRET_PATTERN, "[redacted]");
}

/**
 * Parse a Bearer WWW-Authenticate challenge into fields.
 *
 * @param {unknown} header
 * @returns {{scheme: string, params: Record<string, string>}|null}
 */
export function parseWwwAuthenticate(header) {
  const raw = String(header || "").trim();
  if (!raw) return null;
  const space = raw.indexOf(" ");
  const scheme = (space === -1 ? raw : raw.slice(0, space)).trim();
  const rest = space === -1 ? "" : raw.slice(space + 1);
  const params = new Map();
  for (const part of rest.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (val.startsWith("\"") && val.endsWith("\"")) val = val.slice(1, -1);
    params.set(key, val);
  }
  return { scheme, params: Object.fromEntries(params) };
}

/**
 * Unauthenticated `/mcp` must be 401 with a Bearer resource_metadata challenge.
 *
 * @param {{status: number, wwwAuthenticate?: string, body?: string}} res
 * @param {string} expectedMetadata
 * @returns {{ok: boolean, reason: string}}
 */
export function classifyUnauthenticatedMcp(res, expectedMetadata) {
  const challenge = parseWwwAuthenticate(res.wwwAuthenticate);
  if (res.status !== 401) {
    return { ok: false, reason: `expected 401, got ${res.status}` };
  }
  if (!challenge || challenge.scheme.toLowerCase() !== "bearer") {
    return { ok: false, reason: "missing Bearer WWW-Authenticate" };
  }
  if (challenge.params.resource_metadata !== expectedMetadata) {
    return {
      ok: false,
      reason: `resource_metadata ${challenge.params.resource_metadata || "(missing)"} !== ${expectedMetadata}`,
    };
  }
  return { ok: true, reason: `401 challenge resource_metadata=${expectedMetadata}` };
}

/**
 * A present disallowed Origin must fail closed with 403.
 *
 * @param {{status: number}} res
 * @returns {{ok: boolean, reason: string}}
 */
export function classifyOriginRefused(res) {
  if (res.status !== 403) {
    return { ok: false, reason: `expected 403, got ${res.status}` };
  }
  return { ok: true, reason: "403 foreign Origin" };
}

/**
 * Decode a JWT payload without verifying. Used only to read Keycloak's
 * public error code from `KC_STATE_CHECKER` (mky / mpar). The token is not
 * returned.
 *
 * @param {string} token
 * @returns {object|null}
 */
export function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Read Keycloak authorize HTML/cookies into a secret-free verdict.
 *
 * @param {{status: number, headers?: Record<string, string>, body?: string}} res
 * @returns {{status: number, pageId: string, error: string, errorParam: string}}
 */
export function parseAuthorizeResponse(res) {
  const body = String(res.body || "");
  const pageId = /"pageId":\s*"([^"]+)"/.exec(body)?.[1] || "";
  const headers = res.headers || {};
  const cookie = String(headers["set-cookie"] || headers["Set-Cookie"] || "");
  const match = /KC_STATE_CHECKER=([^;]+)/i.exec(cookie);
  const payload = match ? decodeJwtPayload(match[1]) : null;
  return {
    status: res.status,
    pageId,
    error: String(payload?.mky || ""),
    errorParam: Array.isArray(payload?.mpar) ? payload.mpar.join(",") : "",
  };
}

/**
 * Classify an authorize response.
 *
 * @param {ReturnType<typeof parseAuthorizeResponse>} parsed
 * @param {"login"|"invalid_redirect"|"client_not_found"} expect
 * @returns {{ok: boolean, reason: string}}
 */
export function classifyAuthorize(parsed, expect) {
  if (expect === "login") {
    const ok = parsed.status === 200 && parsed.pageId === "login-username";
    return {
      ok,
      reason: ok
        ? "authorize accepted redirect; login page"
        : `expected login page, status=${parsed.status} pageId=${parsed.pageId || "(none)"}`,
    };
  }
  if (expect === "invalid_redirect") {
    const ok = parsed.status === 400
      && parsed.error === "invalidParameterMessage"
      && parsed.errorParam.includes("redirect_uri");
    return {
      ok,
      reason: ok
        ? "authorize rejected redirect_uri"
        : `expected invalid redirect, status=${parsed.status} error=${parsed.error || "(none)"} param=${parsed.errorParam || "(none)"}`,
    };
  }
  if (expect === "client_not_found") {
    const ok = parsed.status === 400 && parsed.error === "clientNotFoundMessage";
    return {
      ok,
      reason: ok
        ? "authorize unknown client"
        : `expected client_not_found, status=${parsed.status} error=${parsed.error || "(none)"}`,
    };
  }
  return { ok: false, reason: `unknown expect ${expect}` };
}

/**
 * Anonymous DCR must stay closed (Trusted Hosts).
 *
 * @param {{status: number, body?: string}} res
 * @returns {{ok: boolean, reason: string}}
 */
export function classifyDcrClosed(res) {
  const body = String(res.body || "");
  if (res.status !== 403) {
    return { ok: false, reason: `expected 403, got ${res.status}` };
  }
  if (!/Trusted Hosts|Host not trusted/i.test(body)) {
    return { ok: false, reason: "403 without Trusted Hosts refusal" };
  }
  return { ok: true, reason: "403 Trusted Hosts (anonymous DCR closed)" };
}

/**
 * True when `value` is exactly the Paladin issuer URL.
 * Scheme, host, port, and path must match {@link ISSUER}. Userinfo,
 * query, hash, and lookalike hosts do not match.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isExactIssuer(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  let actual;
  try {
    actual = new URL(value);
  } catch {
    return false;
  }
  const expected = new URL(ISSUER);
  return actual.protocol === expected.protocol
    && actual.username === ""
    && actual.password === ""
    && actual.hostname === expected.hostname
    && actual.port === expected.port
    && actual.pathname === expected.pathname
    && actual.search === ""
    && actual.hash === "";
}

/**
 * RFC 9728 protected-resource metadata for a hosted `/mcp`.
 *
 * @param {{status: number, json?: object}} res
 * @param {string} resource
 * @returns {{ok: boolean, reason: string}}
 */
export function classifyProtectedResource(res, resource) {
  if (res.status !== 200 || !res.json) {
    return { ok: false, reason: `expected 200 JSON, got ${res.status}` };
  }
  const servers = res.json.authorization_servers;
  const scopes = Array.isArray(res.json.scopes_supported) ? res.json.scopes_supported : [];
  if (res.json.resource !== resource) {
    return { ok: false, reason: `resource ${res.json.resource} !== ${resource}` };
  }
  if (!Array.isArray(servers) || !servers.some((server) => isExactIssuer(server))) {
    return { ok: false, reason: `authorization_servers missing ${ISSUER}` };
  }
  if (!scopes.includes("mcp_read") || scopes.length !== 1) {
    return { ok: false, reason: `scopes_supported ${JSON.stringify(scopes)}` };
  }
  return { ok: true, reason: `resource=${resource} issuer=${ISSUER} scope=mcp_read` };
}

/**
 * Authorization-server metadata the client follows after PRM.
 *
 * @param {{status: number, json?: object}} res
 * @returns {{ok: boolean, reason: string, cimd: boolean, publicTokenAuth: boolean}}
 */
export function classifyAsMetadata(res) {
  if (res.status !== 200 || !res.json) {
    return { ok: false, reason: `expected 200 JSON, got ${res.status}`, cimd: false, publicTokenAuth: false };
  }
  const methods = res.json.code_challenge_methods_supported || [];
  const scopes = res.json.scopes_supported || [];
  const tokenAuth = res.json.token_endpoint_auth_methods_supported || [];
  const cimd = res.json.client_id_metadata_document_supported === true;
  const publicTokenAuth = tokenAuth.includes("none");
  if (res.json.issuer !== ISSUER) {
    return { ok: false, reason: `issuer ${res.json.issuer}`, cimd, publicTokenAuth };
  }
  if (!methods.includes("S256")) {
    return { ok: false, reason: "code_challenge_methods_supported missing S256", cimd, publicTokenAuth };
  }
  if (!scopes.includes("mcp_read")) {
    return { ok: false, reason: "scopes_supported missing mcp_read", cimd, publicTokenAuth };
  }
  if (!res.json.authorization_endpoint || !res.json.token_endpoint) {
    return { ok: false, reason: "missing authorization or token endpoint", cimd, publicTokenAuth };
  }
  return {
    ok: true,
    reason: `issuer ok, S256, mcp_read; cimd=${cimd}; token_auth_none=${publicTokenAuth}`,
    cimd,
    publicTokenAuth,
  };
}

/**
 * Grok CIMD document must name its own URL as client_id and the two published redirects.
 *
 * @param {{status: number, json?: object}} res
 * @returns {{ok: boolean, reason: string}}
 */
export function classifyGrokCimd(res) {
  if (res.status !== 200 || !res.json) {
    return { ok: false, reason: `expected 200 JSON, got ${res.status}` };
  }
  const redirects = res.json.redirect_uris || [];
  if (res.json.client_id !== GROK_CIMD_URL) {
    return { ok: false, reason: `client_id ${res.json.client_id}` };
  }
  if (res.json.token_endpoint_auth_method !== "none") {
    return { ok: false, reason: "CIMD is not a public client" };
  }
  for (const uri of [
    "https://grok.com/connectors-oauth-exchange-code/",
    "https://console.x.ai/connectors-oauth-exchange-code/",
  ]) {
    if (!redirects.includes(uri)) {
      return { ok: false, reason: `CIMD missing redirect ${uri}` };
    }
  }
  return { ok: true, reason: "CIMD published; client_id is the document URL" };
}

/**
 * Health probe.
 *
 * @param {{status: number, json?: object}} res
 * @returns {{ok: boolean, reason: string}}
 */
export function classifyHealth(res) {
  if (res.status !== 200 || res.json?.status !== "ok") {
    return { ok: false, reason: `expected 200 {status:ok}, got ${res.status}` };
  }
  return { ok: true, reason: "200 {status:ok}" };
}

/**
 * Signed-in initialize / tools/list / tools/call without copying payloads.
 *
 * @param {{status: number, json?: object}} res
 * @param {"initialize"|"tools/list"|"tools/call"} kind
 * @returns {{ok: boolean, reason: string, toolCount?: number}}
 */
export function classifyMcpJsonRpc(res, kind) {
  if (res.status !== 200 || !res.json) {
    return { ok: false, reason: `expected 200 JSON-RPC, got ${res.status}` };
  }
  if (res.json.error) {
    return { ok: false, reason: `JSON-RPC error ${res.json.error.code || ""}`.trim() };
  }
  if (kind === "initialize") {
    const version = res.json.result?.protocolVersion;
    return version
      ? { ok: true, reason: `initialize protocolVersion=${version}` }
      : { ok: false, reason: "initialize missing protocolVersion" };
  }
  if (kind === "tools/list") {
    const tools = res.json.result?.tools;
    if (!Array.isArray(tools)) return { ok: false, reason: "tools/list missing tools" };
    const writes = advertisedWriteLikeTools(tools);
    if (writes.length > 0) {
      return {
        ok: false,
        reason: `tools/list advertised write tools: ${writes.join(", ")}`,
        toolCount: tools.length,
      };
    }
    return { ok: true, reason: `tools/list count=${tools.length}`, toolCount: tools.length };
  }
  const isError = res.json.result?.isError === true;
  if (isError) return { ok: false, reason: "tools/call isError=true" };
  return { ok: true, reason: `tools/call ${READ_TOOL}` };
}

/**
 * Advertised `tools/list` names the connector treats as writes or deletes.
 * Uses {@link isWriteLikeTool} so entity, draft, and drush writes cannot
 * drift from the runtime gate.
 *
 * @param {unknown} tools
 * @returns {string[]}
 */
export function advertisedWriteLikeTools(tools) {
  if (!Array.isArray(tools)) return [];
  const writes = [];
  for (const tool of tools) {
    const name = typeof tool === "string" ? tool : tool?.name;
    if (typeof name === "string" && isWriteLikeTool(name)) writes.push(name);
  }
  return writes;
}

/**
 * Refuse a write-shaped tools/call so the probe stays read-only.
 * Driven by the connector's {@link isWriteLikeTool} table, not a local regex.
 *
 * @param {string} name
 */
export function assertReadOnlyTool(name) {
  if (isWriteLikeTool(String(name || ""))) {
    throw new Error("hosted acceptance is read-only; refused a write tool call");
  }
}

/**
 * PKCE S256 pair. Only the challenge is sent on authorize.
 *
 * @returns {{verifier: string, challenge: string}}
 */
export function buildPkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * @param {string} raw
 * @returns {object|undefined}
 */
function tryJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Milliseconds to wait after a 429. Honors Retry-After seconds when present,
 * otherwise exponential backoff. Capped so a probe cannot hang.
 *
 * @param {{headers?: Record<string, string>}} res
 * @param {number} attempt Zero-based retry count already completed.
 * @returns {number}
 */
export function retryAfterMs(res, attempt) {
  const raw = Number.parseInt(String(res.headers?.["retry-after"] || ""), 10);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(raw * 1000, 15_000);
  return Math.min(400 * (2 ** attempt), 4_000);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{sleep?: (ms: number) => Promise<void>, retries?: number}} [retry]
 */
async function request(fetchImpl, url, init = {}, retry = {}) {
  const sleep = retry.sleep || defaultSleep;
  const retries = retry.retries ?? 4;
  let last;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const res = await fetchImpl(url, { redirect: "manual", ...init });
    const text = await res.text();
    const headers = new Map();
    res.headers.forEach((value, key) => {
      const previous = headers.get(key);
      headers.set(key, previous ? `${previous}, ${value}` : value);
    });
    last = {
      status: res.status,
      headers: Object.fromEntries(headers),
      body: text,
      json: tryJson(text),
      wwwAuthenticate: res.headers.get("www-authenticate") || headers.get("www-authenticate") || "",
    };
    if (last.status !== 429 || attempt === retries - 1) return last;
    await sleep(retryAfterMs(last, attempt));
  }
  return last;
}

/**
 * Token sources. Values stay in the returned object for the HTTP call; they
 * are never copied into a step record.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} hostId
 * @returns {{read: string, wrongAudience: string, expired: string, insufficientScope: string, clientId: string, clientSecret: string}}
 */
export function readTokenConfig(env = process.env, hostId = "staging") {
  const suffix = hostId === "production" ? "PRODUCTION" : "STAGING";
  const stagingOnly = hostId === "staging";
  return {
    read: String(
      env[`HOSTED_MCP_TOKEN_${suffix}`]
      || env.HOSTED_MCP_TOKEN
      || (stagingOnly ? env.EVAL_HTTP_STAGING_TOKEN_READ : "")
      || "",
    ).trim(),
    wrongAudience: String(
      (stagingOnly ? env.EVAL_HTTP_STAGING_TOKEN_WRONG_AUDIENCE : "")
      || env.HOSTED_MCP_TOKEN_WRONG_AUDIENCE
      || "",
    ).trim(),
    expired: String(
      (stagingOnly ? env.EVAL_HTTP_STAGING_TOKEN_EXPIRED : "")
      || env.HOSTED_MCP_TOKEN_EXPIRED
      || "",
    ).trim(),
    insufficientScope: String(
      (stagingOnly ? env.EVAL_HTTP_STAGING_TOKEN_INSUFFICIENT_SCOPE : "")
      || env.HOSTED_MCP_TOKEN_INSUFFICIENT_SCOPE
      || "",
    ).trim(),
    clientId: String(env.HOSTED_MCP_CLIENT_ID || (hostId === "production" ? "mcp-edge-prod-alpha" : "mcp-edge-alpha")).trim(),
    clientSecret: String(env.HOSTED_MCP_CLIENT_SECRET || "").trim(),
  };
}

/**
 * @param {string} method
 * @param {object} [params]
 * @param {number} [id]
 */
function mcpBody(method, params = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function initializeBody() {
  return mcpBody("initialize", {
    protocolVersion: MCP_PROTOCOL,
    capabilities: {},
    clientInfo: { name: "hosted-acceptance", version: "0" },
  });
}

/**
 * @param {object} step
 * @param {{ok: boolean, reason: string}} verdict
 * @param {string} [detail]
 */
function finish(step, verdict, detail) {
  step.ok = verdict.ok;
  step.reason = verdict.reason;
  if (detail) step.detail = redactSecrets(detail);
  return step;
}

/**
 * Run the unauthenticated + authorize suite (and signed-in steps when tokens
 * are present) for one host.
 *
 * @param {object} options
 * @param {typeof fetch} options.fetchImpl
 * @param {(typeof DEFAULT_HOSTS)[number]} options.host
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {() => string} [options.now]
 * @param {{challenge: string}} [options.pkce]
 */
export async function probeHost({
  fetchImpl,
  host,
  env = process.env,
  now = formatEt,
  pkce = buildPkce(),
  sleep = defaultSleep,
}) {
  const generatedAt = now();
  const steps = [];
  const metadataUrl = `${host.origin}/.well-known/oauth-protected-resource/mcp`;
  const tokens = readTokenConfig(env, host.id);
  const send = (url, init) => request(fetchImpl, url, init, { sleep });

  const add = (step) => {
    steps.push({
      host: host.id,
      at: generatedAt,
      ...step,
    });
    return steps[steps.length - 1];
  };

  const health = add({ id: "health", client: "*", expect: "200" });
  finish(health, classifyHealth(await send(`${host.origin}/health`)));

  const prm = add({ id: "protected-resource", client: "*", expect: "200 rfc9728" });
  finish(prm, classifyProtectedResource(
    await send(metadataUrl),
    host.mcpUrl,
  ));

  const asMeta = add({ id: "as-metadata", client: "*", expect: "200 rfc8414" });
  const asRes = await send(`${ISSUER}/.well-known/openid-configuration`);
  const asVerdict = classifyAsMetadata(asRes);
  finish(asMeta, asVerdict);

  const noToken = add({ id: "mcp-no-token", client: "*", expect: "401" });
  finish(noToken, classifyUnauthenticatedMcp(
    await send(host.mcpUrl, {
      method: "POST",
      headers: { accept: ACCEPT, "content-type": "application/json" },
      body: initializeBody(),
    }),
    metadataUrl,
  ));

  const junk = add({ id: "mcp-junk-token", client: "*", expect: "401" });
  const junkRes = await send(host.mcpUrl, {
    method: "POST",
    headers: {
      accept: ACCEPT,
      "content-type": "application/json",
      authorization: "Bearer not-a-real-token",
    },
    body: initializeBody(),
  });
  const junkChallenge = parseWwwAuthenticate(junkRes.wwwAuthenticate);
  finish(junk, {
    ok: junkRes.status === 401 && junkChallenge?.params?.error === "invalid_token",
    reason: junkRes.status === 401
      ? `401 ${junkChallenge?.params?.error_description || "invalid_token"}`
      : `expected 401, got ${junkRes.status}`,
  });

  for (const origin of HOSTED_PUBLIC_CLIENT_ORIGINS) {
    const step = add({ id: `origin-allow:${origin}`, client: origin, expect: "401" });
    finish(step, classifyUnauthenticatedMcp(
      await send(host.mcpUrl, {
        method: "POST",
        headers: {
          accept: ACCEPT,
          "content-type": "application/json",
          origin,
        },
        body: initializeBody(),
      }),
      metadataUrl,
    ));
  }

  for (const origin of FOREIGN_ORIGINS) {
    const step = add({ id: `origin-deny:${origin}`, client: origin, expect: "403" });
    finish(step, classifyOriginRefused(
      await send(host.mcpUrl, {
        method: "POST",
        headers: {
          accept: ACCEPT,
          "content-type": "application/json",
          origin,
        },
        body: initializeBody(),
      }),
    ));
  }

  const authEndpoint = `${ISSUER}/protocol/openid-connect/auth`;
  const authorize = async (clientId, redirectUri) => {
    const url = new URL(authEndpoint);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "mcp_read");
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "hosted-acceptance");
    url.searchParams.set("resource", host.mcpUrl);
    const res = await send(url);
    await sleep(150);
    return parseAuthorizeResponse(res);
  };

  for (const client of CLIENT_PATHS) {
    for (const redirect of client.acceptRedirects) {
      const step = add({
        id: `authorize-accept:${client.clientId}:${redirect}`,
        client: client.id,
        expect: "login",
      });
      finish(step, classifyAuthorize(await authorize(client.clientId, redirect), "login"));
    }
    for (const redirect of client.rejectRedirects) {
      const expect = client.unknownClientExpect || "invalid_redirect";
      const step = add({
        id: `authorize-reject:${client.clientId}:${redirect}`,
        client: client.id,
        expect,
      });
      finish(step, classifyAuthorize(await authorize(client.clientId, redirect), expect));
    }
    if (client.cimdClientId) {
      const step = add({
        id: `authorize-cimd:${client.cimdClientId}`,
        client: client.id,
        expect: client.cimdClientIdExpect,
      });
      finish(step, classifyAuthorize(
        await authorize(client.cimdClientId, client.acceptRedirects[0]),
        client.cimdClientIdExpect,
      ));
    }
  }

  const dcr = add({ id: "dcr-closed", client: "*", expect: "403" });
  finish(dcr, classifyDcrClosed(await send(
    `${ISSUER}/clients-registrations/openid-connect`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://grok.com/connectors-oauth-exchange-code/"],
        client_name: "hosted-acceptance",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "mcp_read",
      }),
    },
  )));

  const cimd = add({ id: "grok-cimd", client: "grok", expect: "200" });
  finish(cimd, classifyGrokCimd(await send(GROK_CIMD_URL)));

  let accessToken = tokens.read;
  if (!accessToken && tokens.clientSecret) {
    const exchange = add({ id: "token-exchange", client: tokens.clientId, expect: "200" });
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: tokens.clientId,
      client_secret: tokens.clientSecret,
      scope: "mcp_read",
      resource: host.mcpUrl,
    });
    const tokenRes = await send(`${ISSUER}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    accessToken = String(tokenRes.json?.access_token || "");
    finish(exchange, {
      ok: tokenRes.status === 200 && Boolean(accessToken),
      reason: tokenRes.status === 200 ? "client_credentials issued mcp_read" : `token HTTP ${tokenRes.status}`,
    });
  }

  const signedIn = [
    ["initialize", initializeBody()],
    ["tools/list", mcpBody("tools/list", {}, 2)],
    ["tools/call", mcpBody("tools/call", { name: READ_TOOL, arguments: {} }, 3)],
  ];
  assertReadOnlyTool(READ_TOOL);
  for (const [kind, body] of signedIn) {
    const step = add({ id: `signed-in:${kind}`, client: "token", expect: "200" });
    if (!accessToken) {
      step.ok = null;
      step.skipped = true;
      step.reason = "no documented token in env (HOSTED_MCP_TOKEN or HOSTED_MCP_CLIENT_SECRET)";
      continue;
    }
    const res = await send(host.mcpUrl, {
      method: "POST",
      headers: {
        accept: ACCEPT,
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body,
    });
    finish(step, classifyMcpJsonRpc(res, kind));
  }

  for (const [label, token] of [
    ["wrong-audience", tokens.wrongAudience],
    ["expired", tokens.expired],
    ["insufficient-scope", tokens.insufficientScope],
  ]) {
    const step = add({ id: `deny-token:${label}`, client: "token", expect: "401" });
    if (!token) {
      step.ok = null;
      step.skipped = true;
      step.reason = `no ${label} token in env`;
      continue;
    }
    const res = await send(host.mcpUrl, {
      method: "POST",
      headers: {
        accept: ACCEPT,
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: initializeBody(),
    });
    finish(step, {
      ok: res.status === 401,
      reason: res.status === 401 ? "401 deny token" : `expected 401, got ${res.status}`,
    });
  }

  const failed = steps.filter((step) => step.ok === false).length;
  const skipped = steps.filter((step) => step.skipped).length;
  const passed = steps.filter((step) => step.ok === true).length;
  return {
    id: host.id,
    mcpUrl: host.mcpUrl,
    generatedAt,
    passed,
    failed,
    skipped,
    ok: failed === 0,
    steps,
  };
}

/**
 * @param {object} [options]
 */
export async function runAcceptance({
  fetchImpl = globalThis.fetch,
  env = process.env,
  hosts = DEFAULT_HOSTS,
  now = formatEt,
  sleep,
} = {}) {
  const reports = [];
  for (const host of hosts) {
    reports.push(await probeHost({ fetchImpl, host, env, now, sleep }));
  }
  return {
    generatedAt: now(),
    issuer: ISSUER,
    origins: [...HOSTED_PUBLIC_CLIENT_ORIGINS],
    ok: reports.every((report) => report.ok),
    hosts: reports,
  };
}

/**
 * Markdown table for the operator report. No secrets.
 *
 * @param {Awaited<ReturnType<typeof runAcceptance>>} report
 * @returns {string}
 */
export function formatMarkdown(report) {
  const lines = [
    "# Hosted MCP acceptance",
    "",
    `Generated: ${report.generatedAt}`,
    `Issuer: ${report.issuer}`,
    `Allowed Origins: ${report.origins.join(", ")}`,
    `Overall: ${report.ok ? "PASS" : "FAIL"}`,
    "",
  ];
  for (const host of report.hosts) {
    lines.push(`## ${host.id} (${host.mcpUrl})`);
    lines.push("");
    lines.push("| Step | Client | Expect | Result | Evidence | At |");
    lines.push("|---|---|---|---|---|---|");
    for (const step of host.steps) {
      const result = step.skipped ? "SKIP" : (step.ok ? "PASS" : "FAIL");
      lines.push(`| ${step.id} | ${step.client} | ${step.expect} | ${result} | ${redactSecrets(step.reason)} | ${step.at} |`);
    }
    lines.push("");
    lines.push(`${host.passed} passed / ${host.failed} failed / ${host.skipped} skipped`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = { requireSignedIn: false, json: false, hosts: null };
  const pending = [...argv];
  while (pending.length > 0) {
    const arg = pending.shift();
    if (arg === "--require-signed-in") args.requireSignedIn = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--host") {
      const id = String(pending.shift() || "").trim();
      args.hosts = DEFAULT_HOSTS.filter((host) => host.id === id);
      if (args.hosts.length === 0) {
        throw new Error(`unknown --host ${id} (staging|production)`);
      }
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function usage() {
  return [
    "hosted MCP acceptance probe (DEV-817 / DEV-953)",
    "",
    "  node scripts/hosted-acceptance.js [--host staging|production] [--json] [--require-signed-in]",
    "",
    "Optional env (never printed): HOSTED_MCP_TOKEN, HOSTED_MCP_TOKEN_STAGING,",
    "HOSTED_MCP_TOKEN_PRODUCTION, HOSTED_MCP_CLIENT_ID, HOSTED_MCP_CLIENT_SECRET,",
    "EVAL_HTTP_STAGING_TOKEN_*.",
    "",
  ].join("\n");
}

/**
 * @param {string[]} argv
 * @param {{fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv, stdout?: {write: Function}, stderr?: {write: Function}}} [io]
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const args = parseArgs(argv);
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  if (args.help) {
    stdout.write(usage());
    return 0;
  }
  const report = await runAcceptance({
    fetchImpl: io.fetchImpl || globalThis.fetch,
    env: io.env || process.env,
    hosts: args.hosts || DEFAULT_HOSTS,
    sleep: io.sleep,
  });
  const env = io.env || process.env;
  const leaked = SECRET_ENV.some((key) => {
    const value = String(Object.hasOwn(env, key) ? Reflect.get(env, key) : "");
    if (!value) return false;
    const blob = `${JSON.stringify(report)}\n${formatMarkdown(report)}`;
    return blob.includes(value);
  });
  if (leaked) {
    stderr.write("hosted-acceptance refused to print a report that contained a secret.\n");
    return 1;
  }
  if (args.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`${formatMarkdown(report)}\n`);
  if (!report.ok) return 1;
  if (args.requireSignedIn) {
    const skippedSignedIn = report.hosts.some((host) =>
      host.steps.some((step) => step.id.startsWith("signed-in:") && step.skipped),
    );
    if (skippedSignedIn) {
      stderr.write("signed-in steps were skipped; pass a documented token or --help.\n");
      return 2;
    }
  }
  return 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${redactSecrets(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  });
}
