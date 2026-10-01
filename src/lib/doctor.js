/**
 * Adoption doctor (DEV-759, DEV-766).
 *
 * Ordered gates. Prints one primary failure plus the exact next fix.
 * Never includes tokens, secrets, or Authorization values in the report.
 */

import fetch from "node-fetch";
import { readFileSync } from "node:fs";
import {
  resolveApiToken,
  resolveOauth,
  authHeadersAsync,
  clientHeaders,
  CLIENT_VERSION,
  getSiteConfig,
} from "./config.js";
import { resolveSecurityConfig, getSecuritySummary } from "./security.js";
import { detectVersionSkew, extractReportedVersions, versionSkewCheck } from "./version-skew.js";
import { formatTransportPresetHelp, isReservedDocumentationHost } from "./transports.js";

/** Doctor checks in the required order. */
export const DOCTOR_CHECK_IDS = [
  "reachability",
  "auth",
  "agent_client",
  "allowlist",
  "readiness",
  "version_skew",
];

/** Readiness reasons that mean the agent client is not registered. */
const CLIENT_NOT_REGISTERED = new Set([
  "designated_consumer_missing",
  "unknown_agent_client",
  "client_not_registered",
  "unknown_client",
]);

const PASS = "pass";
const FAIL = "fail";
const SKIPPED = "skipped";

/** Probe timeout. Matches wizard (do not hang CI). */
const PROBE_TIMEOUT_MS = 4_000;

export const DOCTOR_USAGE = `drupal-mcp-connector doctor

Diagnose the first failing connection gate and print the exact next fix.

  --config <path>     Config file (default: config/config.json or env).
  --site <name>       Site key inside that config.
  --host <url>        Override Drupal base URL.
  --client-id <id>    Agent client id (X-MCP-Client / MCP_CLIENT_ID).
  --preset <id>       Transport preset hint (local-stdio|tailscale|public-https).
  --json              Machine-readable report (no secrets).
  --help              Show this message.

Exit 0 only when no check failed. Skipped optional gates (e.g. undetectable
version skew) do not fail the run.

Transport presets:
${formatTransportPresetHelp()}
`;

/**
 * Parse `--flag`, `--key value`, and `--key=value`.
 * @param {string[]} argv
 * @returns {object}
 */
export function parseDoctorArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=");
    if (inline !== undefined) {
      args[key] = inline;
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      args[key] = argv[++i];
    } else {
      args[key] = true;
    }
  }
  return args;
}

/**
 * Collect secret strings that must never appear in doctor output.
 * @param {object} site
 * @returns {string[]}
 */
export function secretValuesFromSite(site) {
  return [
    site?.apiToken,
    site?.password,
    site?.oauth?.clientSecret,
  ].filter((value) => typeof value === "string" && value.length >= 4);
}

/**
 * Replace known secret substrings in a JSON-able value.
 * @param {*} value
 * @param {string[]} secrets
 * @returns {*}
 */
export function scrubSecrets(value, secrets) {
  if (!secrets.length) return value;
  if (typeof value === "string") {
    let out = value;
    for (const secret of secrets) {
      if (secret && out.includes(secret)) out = out.split(secret).join("[redacted]");
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubSecrets(item, secrets)]),
    );
  }
  return value;
}

/**
 * @param {string} id
 * @param {string} title
 * @param {"pass"|"fail"|"skipped"} status
 * @param {string} detail
 * @param {string|null} [nextFix]
 */
function check(id, title, status, detail, nextFix = null) {
  return { id, title, status, detail, nextFix };
}

/**
 * One HTTP GET that never throws. Network text is not propagated.
 * @param {Function} fetchImpl
 * @param {string} url
 * @param {object} headers
 */
async function probe(fetchImpl, url, headers) {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    let body = null;
    try {
      const text = await res.text();
      if (text) body = JSON.parse(text);
    } catch {
      body = null;
    }
    const rawHeaders = res.headers;
    return {
      unreachable: false,
      status: res.status,
      body,
      headers: {
        get: (name) => (typeof rawHeaders?.get === "function" ? rawHeaders.get(name) : null),
      },
    };
  } catch {
    return { unreachable: true, status: 0, body: null, headers: { get: () => null } };
  }
}

/**
 * Resolve a site for doctor from flags, a config file, env, or loaded config.
 * @param {object} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {object}
 */
export function resolveDoctorSite(args, env = process.env) {
  if (args.host) return siteFromFlags(args, env);
  if (args.config) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator --config path
    const cfg = JSON.parse(readFileSync(String(args.config), "utf8"));
    const name = args.site ? String(args.site) : cfg.defaultSite;
    const raw = new Map(Object.entries(cfg.sites || {})).get(name);
    if (!raw) return { _name: name || "default", baseUrl: "" };
    return resolveOauth(resolveApiToken({ ...raw, _name: name }));
  }
  if (env.DRUPAL_BASE_URL) return siteFromFlags({ ...args, host: env.DRUPAL_BASE_URL }, env);
  try {
    return getSiteConfig(args.site ? String(args.site) : undefined);
  } catch {
    return { _name: args.site ? String(args.site) : "default", baseUrl: env.DRUPAL_BASE_URL || "" };
  }
}

/**
 * @param {object} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {object}
 */
function siteFromFlags(args, env) {
  const site = {
    _name: args.site ? String(args.site) : "default",
    baseUrl: String(args.host || env.DRUPAL_BASE_URL || "").replace(/\/$/, ""),
    requireGovernance: args["no-require-governance"] !== true,
    security: { preset: args.security ? String(args.security) : "production-strict" },
  };
  if (args["oauth-client-id"] || args.auth === "oauth") {
    const secretEnv = String(args["oauth-secret-env"] || "MCP_CONTENT_SECRET");
    site.oauth = {
      clientId: String(args["oauth-client-id"] || ""),
      clientSecretEnv: secretEnv,
      clientSecret: env[secretEnv] || "",
      scopes: ["mcp_read", "mcp_write"],
      grant: "client_credentials",
    };
  } else {
    const tokenEnv = String(args["token-env"] || "DRUPAL_API_TOKEN");
    site.apiTokenEnv = tokenEnv;
    site.apiToken = env[tokenEnv] || env.DRUPAL_API_TOKEN || "";
  }
  return resolveOauth(resolveApiToken(site));
}

/**
 * @param {object} site
 * @returns {boolean}
 */
function hasCredential(site) {
  return Boolean(
    site.apiToken
    || (site.username && site.password)
    || (site.oauth?.clientId && (site.oauth.clientSecret || site.oauth.clientSecretEnv)),
  );
}

/**
 * Agent client identity the connector will send.
 * @param {object} site
 * @param {object} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveAgentClientId(site, args = {}, env = process.env) {
  if (args["client-id"]) return String(args["client-id"]);
  if (env.MCP_CLIENT_ID !== undefined) return env.MCP_CLIENT_ID;
  if (site.clientId) return String(site.clientId);
  const headers = clientHeaders();
  return headers["X-MCP-Client"] || "";
}

/**
 * Run the ordered doctor gates.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function runDoctor(options = {}) {
  const args = options.args || {};
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const connectorVersion = options.connectorVersion || CLIENT_VERSION;
  const site = options.site || resolveDoctorSite(args, env);
  const secrets = secretValuesFromSite(site);
  const clientId = resolveAgentClientId(site, args, env);
  const requireGovernance = Boolean(site.requireGovernance);

  const checks = [];
  let readinessProbe = null;
  let authHeaders = {};
  const host = site.baseUrl || "";

  if (!host) {
    checks.push(check(
      "reachability",
      "Drupal host is reachable",
      FAIL,
      "No Drupal host configured.",
      "Run npx drupal-mcp-connector init --host https://your-site.example (or set DRUPAL_BASE_URL / config.json).",
    ));
  } else if (isReservedDocumentationHost(host)) {
    checks.push(check(
      "reachability",
      "Drupal host is reachable",
      FAIL,
      `Documentation-reserved host (${host}) — not probed.`,
      "Point --host at a real Drupal URL (Local stdio or Tailscale VPN). Public HTTPS is gated/later and is not a hosted SaaS endpoint.",
    ));
  } else {
    const jsonapi = await probe(fetchImpl, `${host}/jsonapi`, {
      Accept: "application/vnd.api+json",
      ...clientHeaders(),
    });
    if (jsonapi.unreachable) {
      const root = await probe(fetchImpl, host, { Accept: "text/html", ...clientHeaders() });
      if (root.unreachable) {
        checks.push(check(
          "reachability",
          "Drupal host is reachable",
          FAIL,
          `No TCP/HTTP response from ${host} (jsonapi or origin).`,
          host.includes(".ts.net")
            ? "Join the Tailscale tailnet on this machine, then retry. Tailscale is VPN-required — this is not a public URL."
            : "Confirm the host URL, DNS, and that this machine can route to Drupal (Local stdio or Tailscale VPN).",
        ));
      } else {
        checks.push(check(
          "reachability",
          "Drupal host is reachable",
          PASS,
          `Origin responded (${root.status}); /jsonapi did not. Enable JSON:API or check the path.`,
        ));
      }
    } else {
      checks.push(check(
        "reachability",
        "Drupal host is reachable",
        PASS,
        `Host responded to /jsonapi with HTTP ${jsonapi.status}.`,
      ));
    }
  }

  const reach = statusOf(checks, "reachability");
  const reachOk = reach === PASS;

  if (!reachOk) {
    checks.push(check("auth", "Auth accepted (not 401)", SKIPPED, "Skipped after reachability failed."));
  } else if (!hasCredential(site)) {
    checks.push(check(
      "auth",
      "Auth accepted (not 401)",
      FAIL,
      "No sealed token or OAuth client credentials are configured.",
      "Re-run init with --auth token --token-env DRUPAL_API_TOKEN (export the token) or --auth oauth. Doctor never prints the secret.",
    ));
  } else {
    try {
      authHeaders = await authHeadersAsync(site);
    } catch {
      checks.push(check(
        "auth",
        "Auth accepted (not 401)",
        FAIL,
        "Credential acquisition failed (OAuth token endpoint or missing secret env).",
        "Export the env var named in oauth.clientSecretEnv / apiTokenEnv. Doctor never prints the secret.",
      ));
    }
    if (statusOf(checks, "auth") === undefined) {
      const authed = await probe(fetchImpl, `${host}/jsonapi`, {
        Accept: "application/vnd.api+json",
        ...clientHeaders(),
        ...authHeaders,
      });
      if (authed.unreachable) {
        checks.push(check(
          "auth",
          "Auth accepted (not 401)",
          FAIL,
          "Authenticated /jsonapi request did not complete.",
          "The host was reachable unauthenticated but the credentialed request failed. Recheck the token endpoint and TLS.",
        ));
      } else if (authed.status === 401) {
        checks.push(check(
          "auth",
          "Auth accepted (not 401)",
          FAIL,
          "Drupal returned HTTP 401 for /jsonapi with the configured credential.",
          "Rotate or re-export the sealed token / OAuth client secret. Confirm Simple OAuth is enabled and the consumer is active.",
        ));
      } else if (authed.status === 404) {
        checks.push(check(
          "auth",
          "Auth accepted (not 401)",
          FAIL,
          "HTTP 404 from /jsonapi — JSON:API is not enabled or the path is wrong.",
          "Enable the core jsonapi module (drush en jsonapi -y) and confirm baseUrl has no extra path prefix.",
        ));
      } else {
        checks.push(check(
          "auth",
          "Auth accepted (not 401)",
          PASS,
          `Authenticated /jsonapi returned HTTP ${authed.status}.`,
        ));
      }
    }
  }

  const authStatus = statusOf(checks, "auth");

  if (clientId === "") {
    checks.push(check(
      "agent_client",
      "Agent client identity is set",
      FAIL,
      "MCP_CLIENT_ID is empty, so the X-MCP-Client identity header is disabled.",
      "Unset the empty MCP_CLIENT_ID or set --client-id (for example cursor-local). The header is a log label, not an auth bypass.",
    ));
  } else if (authStatus === FAIL || authStatus === SKIPPED) {
    checks.push(check(
      "agent_client",
      "Agent client identity is set",
      PASS,
      `Will send X-MCP-Client: ${clientId}. Live registration is checked with readiness.`,
    ));
  } else {
    checks.push(check(
      "agent_client",
      "Agent client identity is set",
      PASS,
      `X-MCP-Client: ${clientId}. Live registration is confirmed on the readiness gate when Sentinel reports it.`,
    ));
  }

  const sec = host ? resolveSecurityConfig(site) : null;
  if (!sec) {
    checks.push(check("allowlist", "Entity allowlist permits a content read", SKIPPED, "Skipped — no site config to inspect."));
  } else if (Array.isArray(sec.allowedEntityTypes) && sec.allowedEntityTypes.length === 0) {
    checks.push(check(
      "allowlist",
      "Entity allowlist permits a content read",
      FAIL,
      "security.allowedEntityTypes is an empty list, so every entity tool is denied.",
      "Set an explicit allowlist that includes node (or use a preset such as production-strict / content-editor). Doctor will not widen it for you.",
    ));
  } else if (Array.isArray(sec.deniedEntityTypes) && sec.deniedEntityTypes.includes("node")
    && Array.isArray(sec.allowedEntityTypes) && !sec.allowedEntityTypes.includes("node")) {
    checks.push(check(
      "allowlist",
      "Entity allowlist permits a content read",
      FAIL,
      "node is denied and not allowlisted, so drupal_list_nodes / drupal_get_node will fail closed.",
      "Add node to security.allowedEntityTypes on a staging preset. Do not auto-widen production allowlists.",
    ));
  } else {
    const summary = getSecuritySummary(site);
    const allowed = summary.allowedEntityTypes === "all"
      ? "all non-denied types"
      : `allowed: ${[].concat(summary.allowedEntityTypes).join(", ")}`;
    checks.push(check(
      "allowlist",
      "Entity allowlist permits a content read",
      PASS,
      `Preset ${summary.preset}; ${allowed}. Sensitive types stay denied.`,
    ));
  }

  if (!reachOk) {
    checks.push(check(
      "readiness",
      "Source governance contract_ready",
      SKIPPED,
      requireGovernance
        ? "Skipped after reachability failed (requireGovernance is on)."
        : "Skipped after reachability failed.",
    ));
  } else {
    try {
      if (!Object.keys(authHeaders).length && hasCredential(site)) {
        authHeaders = await authHeadersAsync(site);
      }
    } catch {
      authHeaders = {};
    }
    readinessProbe = await probe(fetchImpl, `${host}/drupal-mcp/readiness`, {
      Accept: "application/json",
      ...clientHeaders(),
      ...authHeaders,
    });
    if (readinessProbe.unreachable) {
      checks.push(check(
        "readiness",
        "Source governance contract_ready",
        requireGovernance ? FAIL : SKIPPED,
        requireGovernance
          ? "GET /drupal-mcp/readiness did not complete and requireGovernance is on."
          : "GET /drupal-mcp/readiness did not complete. requireGovernance is off, so this is skipped rather than a pass.",
        requireGovernance
          ? "Install and enable mcp_sentinel, or pass --no-require-governance for a local ungoverned experiment. Marketplace listings keep requireGovernance on."
          : null,
      ));
    } else if (readinessProbe.status === 404) {
      checks.push(check(
        "readiness",
        "Source governance contract_ready",
        requireGovernance ? FAIL : SKIPPED,
        "GET /drupal-mcp/readiness returned 404 (MCP Sentinel not installed, or the route is missing).",
        requireGovernance
          ? "composer require drupal/mcp_sentinel && drush en mcp_sentinel -y, then retry doctor."
          : null,
      ));
    } else if (readinessProbe.status === 401 || readinessProbe.status === 403) {
      checks.push(check(
        "readiness",
        "Source governance contract_ready",
        FAIL,
        `Readiness returned HTTP ${readinessProbe.status} (not_authorized_for_governance).`,
        "Grant the consumer access to the readiness route / mcp_read scope. This is an authz miss, not a reason to disable governance.",
      ));
    } else if (readinessProbe.body && readinessProbe.body.contract_ready) {
      checks.push(check(
        "readiness",
        "Source governance contract_ready",
        PASS,
        "contract_ready is true.",
      ));
    } else if (readinessProbe.body?.contract_ready === false) {
      const reason = String(readinessProbe.body.reason ?? "contract_not_ready");
      const clientMiss = CLIENT_NOT_REGISTERED.has(reason);
      if (clientMiss) {
        replaceCheck(checks, "agent_client", check(
          "agent_client",
          "Agent client is registered",
          FAIL,
          `Sentinel readiness reason: ${reason}.`,
          "Register this agent client id on the Drupal consumer / Sentinel designated-consumer list. Do not disable the identity header to skip the gate.",
        ));
      }
      checks.push(check(
        "readiness",
        "Source governance contract_ready",
        FAIL,
        `contract_ready is false (${reason}).`,
        clientMiss
          ? "Register the agent client, then re-run doctor. Widening entity allowlists will not fix a missing consumer."
          : `Fix the Sentinel condition named '${reason}', then re-run npx drupal-mcp-connector doctor.`,
      ));
    } else {
      checks.push(check(
        "readiness",
        "Source governance contract_ready",
        requireGovernance ? FAIL : SKIPPED,
        `Unexpected readiness response (HTTP ${readinessProbe.status}).`,
        "Confirm mcp_sentinel serves GET /drupal-mcp/readiness as JSON { contract_ready, reason }.",
      ));
    }
  }

  checks.push(versionSkewCheck(detectVersionSkew(
    extractReportedVersions(readinessProbe?.body, readinessProbe?.headers),
    connectorVersion,
  )));

  const primaryFailure = checks.find((item) => item.status === FAIL) || null;
  const report = {
    tool: "drupal-mcp-connector doctor",
    connectorVersion,
    ok: !primaryFailure,
    target: { name: site._name, baseUrl: host || null },
    agentClientId: clientId || null,
    primaryFailure: primaryFailure
      ? {
        id: primaryFailure.id,
        title: primaryFailure.title,
        detail: primaryFailure.detail,
        nextFix: primaryFailure.nextFix,
      }
      : null,
    checks,
    happyPath:
      "After doctor is green: call drupal_mcp_whoami → drupal_list_sites → a safe unpublished read " +
      "(drupal_list_nodes with status:false) or dryRun unpublished create. See README Two-minute happy path.",
  };
  return scrubSecrets(report, secrets);
}

/**
 * @param {Array<object>} checks
 * @param {string} id
 * @returns {string|undefined}
 */
function statusOf(checks, id) {
  return checks.find((item) => item.id === id)?.status;
}

/**
 * @param {Array<object>} checks
 * @param {string} id
 * @param {object} next
 */
function replaceCheck(checks, id, next) {
  const index = checks.findIndex((item) => item.id === id);
  if (index === -1) checks.push(next);
  else checks.splice(index, 1, next);
}

/**
 * Human-readable doctor report. One primary failure + next fix.
 * @param {object} report
 * @returns {string}
 */
export function formatDoctorReport(report) {
  const mark = { pass: "PASS", fail: "FAIL", skipped: "SKIP" };
  const lines = [
    `${report.tool} — connector ${report.connectorVersion}`,
    `target: ${report.target?.name ?? "?"} @ ${report.target?.baseUrl ?? "(none)"}`,
    "",
  ];
  for (const item of report.checks) {
    lines.push(`  [${mark[item.status] ?? item.status}] ${item.id} — ${item.detail}`);
  }
  lines.push("");
  if (report.primaryFailure) {
    lines.push(`PRIMARY FAILURE: ${report.primaryFailure.id}`);
    lines.push(`NEXT FIX: ${report.primaryFailure.nextFix || report.primaryFailure.detail}`);
  } else {
    lines.push("All gates passed (or skipped without a required fail).");
    lines.push(report.happyPath);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * CLI entry for doctor.
 * @param {string[]} argv Flags after the command name.
 * @param {{stdout?: {write: function(string): void}, env?: NodeJS.ProcessEnv, fetch?: Function}} [io]
 * @returns {Promise<number>}
 */
export async function runDoctorCli(argv, io = {}) {
  const args = parseDoctorArgs(argv);
  const stdout = io.stdout || process.stdout;
  if (args.help) {
    stdout.write(DOCTOR_USAGE);
    return 0;
  }
  const report = await runDoctor({
    args,
    env: io.env || process.env,
    fetch: io.fetch,
  });
  if (args.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    stdout.write(formatDoctorReport(report));
  }
  return report.ok ? 0 : 1;
}
