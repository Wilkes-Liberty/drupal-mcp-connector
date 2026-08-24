#!/usr/bin/env node
/**
 * install-commands.js — copy generated `/drupal-*` stubs into an operator's
 * client home directories.
 *
 * The canonical files live in `.agents/commands/` (in-repo, harness-agnostic).
 * Claude Code and Grok only auto-load project commands from vendor paths
 * (`.claude/commands/`, `.grok/commands/`). This script writes the *user-level*
 * copies so `/drupal-*` works in every project without committing a vendor
 * folder to this repo or to a consuming application.
 *
 * Default targets: `~/.claude/commands` (Claude adapter) and `~/.grok/commands`
 * (canonical files). Pass `--clients` to subset. Never writes into a project
 * tree.
 *
 * Run: `npm run install:commands -- [--home DIR] [--clients claude,grok,agents]`
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";

import { allDefinitions } from "../src/tools/index.js";
import {
  commandFileName,
  renderCommandMarkdown,
  renderClaudeCommandMarkdown,
} from "./generate-commands.js";

/** Whitelisted install targets. `rel` is under `--home` (default: os.homedir()). */
export const CLIENTS = {
  claude: {
    rel: ".claude/commands",
    render: renderClaudeCommandMarkdown,
  },
  grok: {
    rel: ".grok/commands",
    render: renderCommandMarkdown,
  },
  agents: {
    rel: ".agents/commands",
    render: renderCommandMarkdown,
  },
};

const DEFAULT_CLIENTS = ["claude", "grok"];

/**
 * Parse CLI flags. Unknown flags throw.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{home?: string, clients: string[], help?: boolean}}
 */
export function parseArgs(argv) {
  const out = { clients: [...DEFAULT_CLIENTS] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--home") {
      out.home = argv[++i];
      if (!out.home) throw new Error("--home requires a directory");
      continue;
    }
    if (a.startsWith("--home=")) {
      out.home = a.slice("--home=".length);
      continue;
    }
    if (a === "--clients") {
      const raw = argv[++i];
      if (!raw) throw new Error("--clients requires a comma-separated list");
      out.clients = splitClients(raw);
      continue;
    }
    if (a.startsWith("--clients=")) {
      out.clients = splitClients(a.slice("--clients=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function splitClients(raw) {
  const names = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error("--clients requires at least one client");
  return names;
}

/**
 * Write one `drupal-*.md` per tool into each requested client directory,
 * pruning stale stubs first. Unknown client names fail closed.
 *
 * @param {object} [options]
 * @param {string} [options.home] - Install root (default: os.homedir()).
 * @param {string[]} [options.clients] - Subset of CLIENTS keys.
 * @param {Array<object>} [options.definitions]
 * @returns {Array<{client: string, dir: string, written: string[]}>}
 */
export function install(options = {}) {
  const home = resolve(options.home || homedir());
  const names = options.clients || DEFAULT_CLIENTS;
  const definitions = options.definitions || allDefinitions;

  const results = [];
  for (const name of names) {
    const client = CLIENTS[name];
    if (!client) {
      throw new Error(`Unknown client "${name}". Allowed: ${Object.keys(CLIENTS).join(", ")}`);
    }
    const dir = join(home, client.rel);
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (/^drupal-.*\.md$/.test(f)) rmSync(join(dir, f));
    }
    const written = [];
    for (const def of definitions) {
      const file = commandFileName(def);
      writeFileSync(join(dir, file), client.render(def));
      written.push(file);
    }
    results.push({ client: name, dir, written });
  }
  return results;
}

const HELP = `Usage: node scripts/install-commands.js [--home DIR] [--clients claude,grok,agents]

Copy generated /drupal-* command stubs into operator home directories.
Does not write into a project tree.

  --home DIR       Install root (default: the current user's home)
  --clients LIST   Comma-separated subset of: claude, grok, agents
                   (default: claude,grok)
`;

const invokedDirectly =
  process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.error(HELP);
      process.exit(0);
    }
    const results = install(opts);
    for (const r of results) {
      console.error(`[install-commands] wrote ${r.written.length} files to ${r.dir} (${r.client})`);
    }
  } catch (err) {
    console.error(`[install-commands] ${err.message}`);
    process.exit(1);
  }
}
