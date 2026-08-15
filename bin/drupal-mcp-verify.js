#!/usr/bin/env node
/**
 * Secure-install verifier (#180).
 *
 * Produces evidence that this installation carries the secure, tenant-neutral
 * defaults the governed product claims — rather than asserting it in a README.
 *
 *   npm run verify                          # static checks on config/config.json
 *   npm run verify -- --config config/config.example.json
 *   npm run verify -- --live --site production
 *   npm run verify -- --live --site staging --json > evidence.json
 *
 * Exit code is 0 only when every check that ran passed AND none was skipped:
 * a skipped check is not evidence. The JSON form is the artefact to attach to
 * a release proof; it carries hosts, outcomes and refusal codes, never
 * payloads, tokens or secrets.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import fetch from "node-fetch";
import { verifyStatic, verifyLive } from "../src/lib/verify.js";
import { loadConfig, getSiteConfig, resolveOauth } from "../src/lib/config.js";
import { callServerTool } from "../src/lib/server-tools.js";

/** Parses `--flag`, `--key value` and `--key=value`. */
function parseArgs(argv) {
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

const USAGE = `drupal-mcp-connector verify

  --config <path>   Verify this configuration file instead of the loaded one.
  --live            Also verify a running target (needs credentials in env).
  --site <name>     Which site to verify live. Defaults to the default site.
  --json            Print the evidence document instead of a summary.
  --help            Show this message.
`;

/** Human-readable one-line-per-check report. */
function report(evidence) {
  const mark = { pass: "PASS", fail: "FAIL", skipped: "SKIP" };
  const lines = [
    `${evidence.tool} (${evidence.mode}) — connector ${evidence.connectorVersion}`,
    `subject: ${JSON.stringify(evidence.subject)}`,
    "",
  ];
  for (const check of evidence.checks) {
    lines.push(`  [${mark[check.status]}] ${check.id} — ${check.title}`);
    for (const finding of check.findings) lines.push(`         ${finding}`);
  }
  lines.push("");
  lines.push(`  ${evidence.summary.pass} passed, ${evidence.summary.fail} failed, ${evidence.summary.skipped} skipped`);
  lines.push("");
  lines.push("  Managed residuals (not solved by this stack):");
  for (const residual of evidence.residuals) lines.push(`    - ${residual.id}: ${residual.detail}`);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = args.config
    ? JSON.parse(readFileSync(String(args.config), "utf8"))
    : loadConfig();
  const source = args.config ? String(args.config) : "config/config.json";

  // Documentation keys (leading underscore) are prose, not configuration.
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, strip(v)]),
      );
    }
    return value;
  };

  const evidence = [verifyStatic(strip(config), { source })];

  if (args.live) {
    const siteName = args.site ? String(args.site) : undefined;
    // getSiteConfig resolves secrets from the environment; nothing is read
    // from the config file itself.
    const site = args.config
      ? resolveOauth({ ...(config.sites?.[siteName ?? config.defaultSite] ?? {}), _name: siteName ?? config.defaultSite })
      : getSiteConfig(siteName);
    // The real bridge client, so the governed-tool probes exercise the real
    // contract (MCP session, tool_api name, tool-level refusal) rather than a
    // hand-rolled JSON-RPC body the server would reject as malformed.
    evidence.push(await verifyLive(site, { transport: fetch, callTool: callServerTool }));
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(evidence.length === 1 ? evidence[0] : evidence, null, 2) + "\n");
  } else {
    process.stdout.write(evidence.map(report).join("\n\n") + "\n");
  }

  return evidence.every((e) => e.summary.ok) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`verify: ${err?.message ?? err}\n`);
    process.exit(2);
  });
