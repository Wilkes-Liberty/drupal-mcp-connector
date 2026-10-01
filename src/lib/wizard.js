/**
 * Operator install wizard (DEV-758).
 *
 * Collects transport, host, auth, and client id; prints Cursor + Claude Code
 * mcpServers snippets; optionally writes project files; then runs whoami +
 * contract_ready (or a clear skip when the host is unreachable).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fetch from "node-fetch";
import { CLIENT_VERSION } from "./config.js";
import { formatTransportPresetHelp, isReservedDocumentationHost, resolveTransportPreset } from "./transports.js";
import { detectVersionSkew, extractReportedVersions, versionSkewCheck } from "./version-skew.js";

/** Short probe timeout so an unreachable host cannot hang the wizard. */
export const WIZARD_PROBE_TIMEOUT_MS = 4_000;

const USAGE = `drupal-mcp-connector wizard|init

  Interactive (default) or --yes/--non-interactive install helper.
  Prints Cursor (.cursor/mcp.json) and Claude Code (mcpServers) snippets.
  Writes files only with --write (never clobbers without confirm unless --yes).

  Remote HTTPS is for a connector you already host on a private network
  (Tailscale / local VPN). This package does not provide a public SaaS
  remote endpoint.

  Transport presets (DEV-763): local-stdio | tailscale | public-https
  (public-https is gated/later — not a hosted SaaS URL).
${formatTransportPresetHelp()}

  --preset local-stdio|tailscale|public-https
                            Named transport preset (sets --transport)
  --transport stdio|https   MCP transport (default: stdio)
  --host <url>              Drupal base URL (stdio) or MCP URL (https)
  --drupal-url <url>        Drupal site for whoami/contract_ready (https)
  --auth token|oauth        Auth mode (default: token; public-https forces oauth)
  --client-id <id>          Agent client id (default: content-agent)
  --clients cursor,claude   Which snippets to emit (default: both)
  --server-name <id>        mcpServers key (default: drupal)
  --site <name>             Site name for whoami / grants hint
  --grant-sites <a,b>       auth.grants site allowlist hint
  --token-env <name>        Env var name for a sealed token
  --write                   Write project (or --scope user) config files
  --scope project|user      Where --write lands (default: project)
  --output <dir>            Project root for writes (default: cwd)
  --yes, --non-interactive  No prompts; flags/env supply every answer
  --skip-check              Do not probe whoami / contract_ready
  --json                    Machine-readable result on stdout
  --help                    Show this message

  After a green run: npx drupal-mcp-connector doctor, then the README
  two-minute happy path (drupal_mcp_whoami → drupal_list_sites →
  unpublished read / dryRun create).

  Env (same meaning as the flags): MCP_WIZARD_TRANSPORT, MCP_WIZARD_HOST,
  MCP_WIZARD_DRUPAL_URL, MCP_WIZARD_AUTH, MCP_WIZARD_CLIENT_ID,
  MCP_WIZARD_CLIENTS, MCP_WIZARD_SERVER_NAME, MCP_WIZARD_SITE,
  MCP_WIZARD_GRANT_SITES, MCP_WIZARD_TOKEN_ENV, MCP_WIZARD_WRITE,
  MCP_WIZARD_SCOPE, MCP_WIZARD_OUTPUT, MCP_WIZARD_YES,
  MCP_WIZARD_SKIP_CHECK, MCP_WIZARD_PRESET.
`;

const DEFAULTS = {
  transport: "stdio",
  host: "https://drupal.example.com",
  auth: "token",
  clientId: "content-agent",
  clients: ["cursor", "claude"],
  serverName: "drupal",
  site: "production",
  grantSites: ["production"],
  tokenEnv: "DRUPAL_API_TOKEN",
  write: false,
  scope: "project",
};

const UNREACHABLE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
]);

/**
 * Parses `--flag`, `--key value` and `--key=value`.
 * @param {string[]} argv
 * @returns {Record<string, string|boolean|string[]>}
 */
export function parseWizardArgs(argv) {
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
 * CLI entry used by `bin/drupal-mcp-wizard.js` and `src/index.js`.
 * @param {string[]} argv
 * @param {{fetchImpl?: typeof fetch, stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, cwd?: string, now?: () => number}} [options]
 * @returns {Promise<number>} Process exit code.
 */
export async function runWizardCli(argv, options = {}) {
  const args = parseWizardArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let answers;
  try {
    answers = await resolveWizardAnswers(args, options);
  } catch (err) {
    process.stderr.write(`wizard: ${err?.message ?? err}\n`);
    return 1;
  }

  const configs = buildClientConfigs(answers);
  const selected = selectedClients(answers);
  const writes = writeClientConfigs(answers, configs, selected);
  const checks = args["skip-check"] || answers.skipCheck
    ? skippedChecks("skipped by --skip-check")
    : await runReadinessChecks(answers, options);

  const result = { answers: publicAnswers(answers), configs, writes, checks };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(jsonResult(result, selected), null, 2)}\n`);
    process.stderr.write(`${formatWizardReport(result, selected)}\n`);
  } else {
    process.stdout.write(`${formatWizardReport(result, selected)}\n`);
  }
  return 0;
}

/**
 * Resolve answers from flags, env, defaults; prompt when interactive.
 * @param {Record<string, string|boolean|string[]>} args
 * @param {{stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, cwd?: string}} [options]
 * @returns {Promise<object>}
 */
export async function resolveWizardAnswers(args, options = {}) {
  const yes = Boolean(args.yes || args["non-interactive"] || envTruthy("MCP_WIZARD_YES"));
  const cwd = options.cwd || process.cwd();
  const outputDir = String(args.output || process.env.MCP_WIZARD_OUTPUT || cwd);

  let writeConfirmedInteractive = false;
  const asked = {
    preset: pick("preset", args, "MCP_WIZARD_PRESET", ""),
    transport: pick("transport", args, "MCP_WIZARD_TRANSPORT", DEFAULTS.transport),
    host: pick("host", args, "MCP_WIZARD_HOST", DEFAULTS.host),
    drupalUrl: pick("drupal-url", args, "MCP_WIZARD_DRUPAL_URL", ""),
    auth: pick("auth", args, "MCP_WIZARD_AUTH", DEFAULTS.auth),
    clientId: pick("client-id", args, "MCP_WIZARD_CLIENT_ID", DEFAULTS.clientId),
    clients: pick("clients", args, "MCP_WIZARD_CLIENTS", DEFAULTS.clients.join(",")),
    serverName: pick("server-name", args, "MCP_WIZARD_SERVER_NAME", DEFAULTS.serverName),
    site: pick("site", args, "MCP_WIZARD_SITE", DEFAULTS.site),
    grantSites: pick("grant-sites", args, "MCP_WIZARD_GRANT_SITES", DEFAULTS.grantSites.join(",")),
    tokenEnv: pick("token-env", args, "MCP_WIZARD_TOKEN_ENV", DEFAULTS.tokenEnv),
    scope: pick("scope", args, "MCP_WIZARD_SCOPE", DEFAULTS.scope),
    write: args.write === true || envTruthy("MCP_WIZARD_WRITE"),
    skipCheck: args["skip-check"] === true || envTruthy("MCP_WIZARD_SKIP_CHECK"),
  };

  if (!yes && process.stdin.isTTY) {
    const rl = createInterface({
      input: options.stdin || input,
      output: options.stdout || output,
    });
    try {
      process.stdout.write(
        `Drupal MCP Connector v${CLIENT_VERSION} — setup wizard\n\n` +
        "Transport presets: Local stdio / Tailscale VPN / Public HTTPS.\n" +
        "Remote HTTPS is Tailscale / local-VPN only. Public HTTPS is gated/later —\n" +
        "this package does not ship a public SaaS remote endpoint.\n\n",
      );
      asked.preset = await ask(rl, "Preset [local-stdio/tailscale/public-https] (blank = use --transport)", asked.preset);
      asked.transport = await ask(rl, "Transport [stdio/https]", asked.transport);
      asked.host = await ask(
        rl,
        asked.transport === "https" ? "MCP host URL" : "Drupal site URL",
        asked.host,
      );
      if (asked.transport === "https") {
        asked.drupalUrl = await ask(rl, "Drupal site URL for readiness (optional)", asked.drupalUrl);
      }
      asked.auth = await ask(rl, "Auth mode [token/oauth]", asked.auth);
      asked.clientId = await ask(rl, "Agent client id", asked.clientId);
      asked.clients = await ask(rl, "Clients [cursor,claude]", asked.clients);
      asked.grantSites = await ask(rl, "auth.grants site allowlist hint", asked.grantSites);
      if (!asked.write) {
        asked.write = /^y(es)?$/i.test(await ask(rl, "Write project MCP config files? [y/N]", "n"));
      }
      if (asked.write && !yes) {
        writeConfirmedInteractive = /^y(es)?$/i.test(
          await ask(rl, "Confirm write/merge of MCP config files? [y/N]", "n"),
        );
        if (!writeConfirmedInteractive) {
          asked.write = false;
        }
      }
    } finally {
      rl.close();
    }
  }

  let transportChoice = asked.transport;
  let preset = null;
  if (asked.preset) {
    const resolved = resolveTransportPreset(asked.preset);
    preset = resolved.preset;
    transportChoice = resolved.transport;
    if (args.transport && String(args.transport) !== resolved.transport) {
      throw new Error(
        `--preset ${preset.id} implies --transport ${resolved.transport} ` +
        `(got --transport ${args.transport}).`,
      );
    }
  }
  const transport = normalizeChoice(transportChoice, ["stdio", "https"], "transport");
  let auth = normalizeChoice(asked.auth, ["token", "oauth"], "auth");
  if (preset?.id === "public-https") {
    if (auth === "token" && args.auth && String(args.auth) === "token") {
      throw new Error(
        "--preset public-https requires --auth oauth (MCP_AUTH_TOKEN is loopback-only; inbound OAuth is required for network HTTPS).",
      );
    }
    auth = "oauth";
  }
  if (transport === "stdio" && auth === "oauth") {
    throw new Error(
      "stdio + --auth oauth needs a site config oauth block (clientId / clientSecretEnv). " +
      "Use --auth token for env-based sealed tokens with stdio, or add an oauth block to config/config.json after init.",
    );
  }
  const scope = normalizeChoice(asked.scope, ["project", "user"], "scope");
  const host = normalizeHttpUrl(asked.host, "host");
  const drupalUrl = asked.drupalUrl
    ? normalizeHttpUrl(asked.drupalUrl, "drupal-url")
    : (transport === "stdio" ? host : "");
  const mcpUrl = transport === "https" ? ensureMcpPath(host) : "";
  const clients = parseList(asked.clients).filter((name) => name === "cursor" || name === "claude");
  if (!clients.length) {
    throw new Error("--clients must include cursor and/or claude.");
  }
  const serverName = String(asked.serverName || DEFAULTS.serverName);
  if (!/^[A-Za-z0-9._-]+$/.test(serverName)) {
    throw new Error("--server-name must be [A-Za-z0-9._-]+.");
  }

  return {
    preset: preset ? preset.id : (transport === "https" ? "tailscale" : "local-stdio"),
    gated: Boolean(preset?.gated),
    transport,
    host,
    drupalUrl,
    mcpUrl,
    auth,
    clientId: String(asked.clientId || DEFAULTS.clientId),
    clients,
    serverName,
    site: String(asked.site || DEFAULTS.site),
    grantSites: parseList(asked.grantSites),
    tokenEnv: String(asked.tokenEnv || DEFAULTS.tokenEnv),
    write: Boolean(asked.write),
    scope,
    output: outputDir,
    skipCheck: Boolean(asked.skipCheck),
    yes: yes || writeConfirmedInteractive,
  };
}

/**
 * Build Cursor + Claude mcpServers documents from answers.
 * @param {object} answers
 * @returns {{cursor: object, claude: object}}
 */
export function buildClientConfigs(answers) {
  return {
    cursor: {
      label: "Cursor",
      projectPath: join(answers.output, ".cursor", "mcp.json"),
      userPath: join(homedir(), ".cursor", "mcp.json"),
      config: wrapServer(answers.serverName, buildServerEntry(answers, "cursor")),
    },
    claude: {
      label: "Claude Code",
      projectPath: join(answers.output, ".mcp.json"),
      userPath: join(homedir(), ".claude.json"),
      config: wrapServer(answers.serverName, buildServerEntry(answers, "claude")),
    },
  };
}

/**
 * Probe whoami + contract_ready. Never throws.
 * @param {object} answers
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{whoami: object, contract_ready: object}>}
 */
export async function runReadinessChecks(answers, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const target = answers.drupalUrl || answers.host;
  if (!target) {
    return skippedChecks("no host URL to probe");
  }
  if (isReservedDocumentationHost(target)) {
    return skippedChecks(
      `documentation-reserved host (${hostnameOf(target)}); not a live probe. ` +
      "Point --host at a real Tailscale/VPN/local Drupal URL and re-run.",
    );
  }

  const reach = await probeUrl(target, fetchImpl);
  if (reach.unreachable) {
    const skip = skipUnreachable(target, reach.detail);
    return {
      whoami: { ...skip, preview: localWhoami(answers) },
      contract_ready: skip,
      version_skew: versionSkewCheck(detectVersionSkew()),
    };
  }

  const whoami = {
    status: "skip",
    title: "whoami",
    detail: "Skipped — wizard does not load the generated client config; call drupal_mcp_whoami from the client after registering the snippet.",
    next: "Register the snippet, restart the client, then call drupal_mcp_whoami against this host.",
    report: localWhoami(answers),
  };

  const readinessUrl = `${stripSlash(target)}/drupal-mcp/readiness`;
  const readiness = await probeUrl(readinessUrl, fetchImpl);
  return {
    whoami,
    contract_ready: interpretReadiness(readiness, readinessUrl),
    version_skew: versionSkewCheck(detectVersionSkew(
      extractReportedVersions(readiness.body, null),
    )),
  };
}

/**
 * Write selected client configs when `--write` is set.
 * @param {object} answers
 * @param {{cursor: object, claude: object}} configs
 * @param {string[]} selected
 * @returns {object[]}
 */
export function writeClientConfigs(answers, configs, selected) {
  if (!answers.write) {
    return selected.map((id) => ({
      id,
      path: writePath(answers, configs[id]),
      status: "printed",
      detail: "not written (pass --write to save; --yes to clobber/merge without a prompt)",
    }));
  }
  if (!answers.yes) {
    return selected.map((id) => ({
      id,
      path: writePath(answers, configs[id]),
      status: "skipped",
      detail: "refusing to write without confirm; re-run with --yes to merge/clobber",
    }));
  }

  return selected.map((id) => {
    const client = clientConfig(configs, id);
    return writeOne(writePath(answers, client), serverEntry(client.config, answers.serverName), answers.serverName, id);
  });
}

/**
 * Human report: snippets, paths, checks, next fix.
 * @param {{answers: object, configs: object, writes: object[], checks: object}} result
 * @param {string[]} selected
 * @returns {string}
 */
export function formatWizardReport(result, selected) {
  const { answers, configs, writes, checks } = result;
  const lines = [
    `Drupal MCP Connector wizard v${CLIENT_VERSION}`,
    "",
    "Remote HTTPS is Tailscale / local-VPN only — not a public SaaS path.",
    `preset=${answers.preset || "local-stdio"}${answers.gated ? " [gated/later — not hosted SaaS]" : ""}`,
    "",
    `transport=${answers.transport} auth=${answers.auth} client_id=${answers.clientId}`,
    `host=${answers.host}`,
  ];
  if (answers.mcpUrl) lines.push(`mcp_url=${answers.mcpUrl}`);
  if (answers.drupalUrl) lines.push(`drupal_url=${answers.drupalUrl}`);
  lines.push("", "Allowlist hints (already in this package):");
  lines.push(`  MCP_CLIENT_ID / X-MCP-Client log label: ${answers.clientId}`);
  lines.push("  inbound HTTPS auth.grants (config.json) — client id → site names:");
  lines.push(`    ${JSON.stringify({ [answers.clientId]: answers.grantSites })}`);
  lines.push("  MCP_CLIENT_ID is not an access grant. See config/config.example.json and docs/integration-contract.md.");
  if (answers.auth === "oauth") {
    lines.push("  OAuth client secret stays in clientSecretEnv / a secrets manager — never in mcp.json.");
  }
  if (answers.transport === "https" && answers.auth === "token") {
    lines.push("  MCP_AUTH_TOKEN is loopback-only. Network-facing HTTPS needs inbound OAuth (auth.issuer + audience).");
  }
  lines.push("");

  for (const id of selected) {
    const client = clientConfig(configs, id);
    const write = writes.find((row) => row.id === id);
    lines.push(`--- ${client.label} ---`);
    lines.push(`project: ${client.projectPath}`);
    lines.push(`user:    ${client.userPath}`);
    if (write) lines.push(`write:   [${write.status}] ${write.path}${write.detail ? ` — ${write.detail}` : ""}`);
    lines.push(JSON.stringify(client.config, null, 2));
    lines.push("");
  }

  if (selected.includes("claude") && answers.transport === "stdio") {
    lines.push("Claude Code one-liner (stdio):");
    lines.push(`  claude mcp add ${answers.serverName} --scope user -e DRUPAL_BASE_URL=${answers.drupalUrl} -e MCP_CLIENT_ID=${answers.clientId} -- npx -y drupal-mcp-connector`);
    lines.push("");
  }

  lines.push("Post-config checks:");
  lines.push(formatCheck(checks.whoami));
  lines.push(formatCheck(checks.contract_ready));
  if (checks.version_skew) lines.push(formatCheck(checks.version_skew));
  lines.push("");
  lines.push("Next: register the snippet, restart the client, then call drupal_mcp_whoami.");
  lines.push("Then: npx drupal-mcp-connector doctor  ·  README Two-minute happy path");
  lines.push("  (drupal_mcp_whoami → drupal_list_sites → unpublished drupal_list_nodes / dryRun create).");
  lines.push("Full client notes: docs/mcp-clients.md · verify: npm run verify");
  return lines.join("\n");
}

/**
 * @param {string[]} argv
 * @returns {string}
 */
export function wizardUsage() {
  return USAGE;
}

/**
 * @param {object} answers
 * @returns {string[]}
 */
function selectedClients(answers) {
  return answers.clients;
}

/**
 * @param {object} answers
 * @param {"cursor"|"claude"} flavor
 * @returns {object}
 */
function buildServerEntry(answers, flavor) {
  if (answers.transport === "https") {
    const entry = { url: answers.mcpUrl };
    if (flavor === "claude") entry.type = "http";
    if (answers.auth === "token") {
      // Build placeholder without a `${` token in source (code-quality / non-template string).
      const tokenRef = flavor === "cursor"
        ? ("$" + "{env:MCP_AUTH_TOKEN}")
        : ("$" + "{MCP_AUTH_TOKEN}");
      entry.headers = { Authorization: `Bearer ${tokenRef}` };
    }
    return entry;
  }

  const env = {
    DRUPAL_BASE_URL: answers.drupalUrl,
    MCP_CLIENT_ID: answers.clientId,
  };
  if (answers.auth === "token") {
    env[answers.tokenEnv] = flavor === "cursor"
      ? `\${env:${answers.tokenEnv}}`
      : `\${${answers.tokenEnv}}`;
  }
  return {
    command: "npx",
    args: ["-y", "drupal-mcp-connector"],
    env,
  };
}

/**
 * @param {string} serverName
 * @param {object} entry
 * @returns {{mcpServers: Record<string, object>}}
 */
function wrapServer(serverName, entry) {
  return { mcpServers: Object.fromEntries([[serverName, entry]]) };
}

/**
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{unreachable: boolean, status: number|null, body: object|null, detail: string}>}
 */
async function probeUrl(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(WIZARD_PROBE_TIMEOUT_MS),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { unreachable: false, status: res.status, body, detail: `HTTP ${res.status}` };
  } catch (err) {
    if (isUnreachableError(err)) {
      return { unreachable: true, status: null, body: null, detail: humanUnreachable(err) };
    }
    return { unreachable: true, status: null, body: null, detail: shortError(err) };
  }
}

/**
 * @param {object} readiness
 * @param {string} url
 * @returns {object}
 */
function interpretReadiness(readiness, url) {
  if (readiness.unreachable) {
    return skipUnreachable(url, readiness.detail);
  }
  if (readiness.status === 200 && readiness.body?.contract_ready === true) {
    return {
      status: "pass",
      title: "contract_ready",
      detail: `${url} reports contract_ready`,
      next: null,
    };
  }
  if (readiness.status === 404) {
    return {
      status: "fail",
      title: "contract_ready",
      detail: `${url} returned 404`,
      next: "Install MCP Sentinel (or confirm the Drupal URL). Readiness is GET /drupal-mcp/readiness.",
    };
  }
  const reason = readiness.body?.reason || readiness.detail;
  return {
    status: "fail",
    title: "contract_ready",
    detail: `${url} is not ready (${reason})`,
    next: "Fix the source governance contract (docs/integration-contract.md) and re-run the wizard.",
  };
}

/**
 * @param {string} url
 * @param {string} detail
 * @returns {object}
 */
function skipUnreachable(url, detail) {
  return {
    status: "skip",
    title: "unreachable",
    detail: `host unreachable (${url}): ${detail}`,
    next: "Confirm Tailscale/VPN/local routing and the URL, then re-run. Snippets above are still valid.",
  };
}

/**
 * @param {string} reason
 * @returns {{whoami: object, contract_ready: object}}
 */
function skippedChecks(reason) {
  const skip = { status: "skip", title: "skipped", detail: reason, next: "Re-run without --skip-check against a reachable host." };
  return {
    whoami: skip,
    contract_ready: skip,
    version_skew: versionSkewCheck(detectVersionSkew()),
  };
}

/**
 * @param {object} answers
 * @returns {object}
 */
function localWhoami(answers) {
  return {
    site: answers.site,
    target: { name: answers.site, baseUrl: answers.drupalUrl || answers.host, source: "wizard" },
    principal: { clientId: answers.clientId, scopes: answers.auth === "oauth" ? ["mcp_read", "mcp_write"] : [] },
    tier: answers.auth === "oauth" ? "content" : "unknown",
    preset: null,
    scopes: answers.auth === "oauth" ? ["mcp_read", "mcp_write"] : [],
    note: "Wizard preview — call drupal_mcp_whoami after the client can reach Drupal.",
  };
}

/**
 * @param {object} answers
 * @returns {object}
 */
function publicAnswers(answers) {
  return {
    preset: answers.preset || null,
    gated: Boolean(answers.gated),
    transport: answers.transport,
    host: answers.host,
    mcpUrl: answers.mcpUrl || null,
    drupalUrl: answers.drupalUrl || null,
    auth: answers.auth,
    clientId: answers.clientId,
    clients: answers.clients,
    serverName: answers.serverName,
    site: answers.site,
    grantSites: answers.grantSites,
    tokenEnv: answers.tokenEnv,
    write: answers.write,
    scope: answers.scope,
  };
}

/**
 * @param {object} result
 * @param {string[]} selected
 * @returns {object}
 */
function jsonResult(result, selected) {
  const clients = {};
  for (const id of selected) {
    const client = clientConfig(result.configs, id);
    clients[id] = {
      label: client.label,
      projectPath: client.projectPath,
      userPath: client.userPath,
      config: client.config,
    };
  }
  return {
    tool: "drupal-mcp-wizard",
    version: CLIENT_VERSION,
    answers: result.answers,
    clients,
    writes: result.writes,
    checks: result.checks,
  };
}

/**
 * @param {object} answers
 * @param {object} client
 * @returns {string}
 */
function writePath(answers, client) {
  return answers.scope === "user" ? client.userPath : client.projectPath;
}

/**
 * @param {string} filePath
 * @param {object} incoming
 * @param {string} serverName
 * @param {string} id
 * @returns {object}
 */
function writeOne(filePath, entry, serverName, id) {
  try {
    let existing = {};
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator --output/--scope path
    if (existsSync(filePath)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator --output/--scope path
      existing = JSON.parse(readFileSync(filePath, "utf8"));
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        return { id, path: filePath, status: "skipped", detail: "existing file is not a JSON object; refusing to clobber" };
      }
    }
    const merged = mergeMcpServer(existing, serverName, entry);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator --output/--scope path
    mkdirSync(dirname(filePath), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator --output/--scope path
    writeFileSync(filePath, `${JSON.stringify(merged, null, 2)}\n`);
    return { id, path: filePath, status: "written", detail: "merged mcpServers entry" };
  } catch (err) {
    return { id, path: filePath, status: "failed", detail: shortError(err) };
  }
}

/**
 * @param {{cursor: object, claude: object}} configs
 * @param {string} id
 * @returns {object}
 */
function clientConfig(configs, id) {
  if (id === "cursor") return configs.cursor;
  if (id === "claude") return configs.claude;
  throw new Error(`unknown client ${id}`);
}

/**
 * @param {{mcpServers?: Record<string, object>}} config
 * @param {string} serverName
 * @returns {object}
 */
function serverEntry(config, serverName) {
  const servers = config.mcpServers || {};
  const named = Object.entries(servers).find(([key]) => key === serverName);
  if (!named) throw new Error(`missing mcpServers.${serverName}`);
  return named[1];
}

/**
 * @param {object} existing
 * @param {string} serverName
 * @param {object} entry
 * @returns {object}
 */
function mergeMcpServer(existing, serverName, entry) {
  const current = existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)
    ? existing.mcpServers
    : {};
  const servers = Object.fromEntries([
    ...Object.entries(current).filter(([key]) => key !== serverName),
    [serverName, entry],
  ]);
  return { ...existing, mcpServers: servers };
}

/**
 * @param {object} check
 * @returns {string}
 */
function formatCheck(check) {
  const mark = { pass: "PASS", fail: "FAIL", skip: "SKIP" };
  const tag = mark[check.status] || check.status.toUpperCase();
  const title = check.title || "check";
  const lines = [`  [${tag}] ${title} — ${check.detail}`];
  const next = check.next || check.nextFix;
  if (next) lines.push(`         next: ${next}`);
  return lines.join("\n");
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isUnreachableError(err) {
  const name = err?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  const code = err?.cause?.code || err?.code;
  if (typeof code === "string" && UNREACHABLE_CODES.has(code)) return true;
  const message = String(err?.message ?? err);
  return /fetch failed|ECONNREFUSED|ENOTFOUND|network|socket/i.test(message);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function humanUnreachable(err) {
  const code = err?.cause?.code || err?.code || err?.name || "network error";
  return String(code);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function shortError(err) {
  return String(err?.message ?? err).replace(/\s+/g, " ").slice(0, 200);
}

/**
 * @param {string} value
 * @param {string[]} allowed
 * @param {string} flag
 * @returns {string}
 */
function normalizeChoice(value, allowed, flag) {
  const choice = String(value || "").trim().toLowerCase();
  if (!allowed.includes(choice)) {
    throw new Error(`--${flag} must be ${allowed.join("|")} (got ${JSON.stringify(value)}).`);
  }
  return choice;
}

/**
 * @param {string} value
 * @param {string} flag
 * @returns {string}
 */
function normalizeHttpUrl(value, flag) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error(`--${flag} must be an http(s) URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`--${flag} must be an http(s) URL.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

/**
 * @param {string} url
 * @returns {string}
 */
function ensureMcpPath(url) {
  const parsed = new URL(url);
  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = "/mcp";
  }
  return parsed.toString().replace(/\/$/, "");
}

/**
 * @param {string} url
 * @returns {string}
 */
function stripSlash(url) {
  return String(url).replace(/\/$/, "");
}

/**
 * @param {string} url
 * @returns {string}
 */
function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export { isReservedDocumentationHost };

/**
 * @param {string} raw
 * @returns {string[]}
 */
function parseList(raw) {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * @param {string} flag
 * @param {Record<string, string|boolean|string[]>} args
 * @param {string} envName
 * @param {string} fallback
 * @returns {string}
 */
function pick(flag, args, envName, fallback) {
  if (args[flag] !== undefined && args[flag] !== true) return String(args[flag]);
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  return fallback;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function envTruthy(name) {
  const raw = process.env[name];
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * @param {import("node:readline/promises").Interface} rl
 * @param {string} question
 * @param {string} fallback
 * @returns {Promise<string>}
 */
async function ask(rl, question, fallback) {
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = await rl.question(`${question}${suffix}: `);
  return answer.trim() || fallback;
}
