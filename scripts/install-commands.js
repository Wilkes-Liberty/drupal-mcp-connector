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
 * Default targets: `~/.claude/commands` (Claude adapter), `~/.grok/commands`
 * (canonical files), and `$HOME/.agents/skills/drupal-mcp/` (Codex skill).
 * Pass `--clients` to subset. Never writes into a project tree. Codex custom
 * prompts (`~/.codex/prompts`) are not written — they are deprecated.
 *
 * Module-owned tools (docs/module-tools.md) are written only with `--modules`.
 * That run discovers the tools the local config approves, from the configured
 * sources, and writes `drupal-<namespace>-<alias>.md` stubs. Run it from the
 * directory that holds `config/config.json`.
 *
 * Run: `npm run install:commands -- [--home DIR] [--clients claude,grok,codex,agents] [--modules]`
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";

import { allDefinitions } from "../src/tools/index.js";
import {
  commandFileName,
  moduleCommandFileName,
  MODULE_STUB_MARKER,
  renderCommandMarkdown,
  renderClaudeCommandMarkdown,
  renderCodexSkillMarkdown,
  renderCodexToolsReference,
  CODEX_SKILL_NAME,
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
  // Codex discovers user skills at `$HOME/.agents/skills/<name>/SKILL.md`.
  // One skill for the whole tool surface — not one skill per tool.
  codex: {
    rel: ".agents/skills",
    kind: "skill",
    skillName: CODEX_SKILL_NAME,
    renderSkill: renderCodexSkillMarkdown,
    renderReference: renderCodexToolsReference,
  },
};

const DEFAULT_CLIENTS = ["claude", "grok", "codex"];

/**
 * Parse CLI flags. Unknown flags throw.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{home?: string, clients: string[], modules?: boolean, help?: boolean}}
 */
export function parseArgs(argv) {
  const out = { clients: [...DEFAULT_CLIENTS] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--modules") {
      out.modules = true;
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
 * Decide which module tools get a stub. A name that matches a built-in command,
 * or that two module tools share, is refused so no command is shadowed.
 *
 * @param {Array<object>} moduleDefinitions - Definitions from live discovery.
 * @param {Array<object>} [definitions] - Built-in definitions.
 * @returns {{stubs: Array<{file: string, def: object}>, refused: Array<{name: string, file: ?string, reason: string}>}}
 */
export function planModuleStubs(moduleDefinitions, definitions = allDefinitions) {
  const builtIn = new Set(definitions.map(commandFileName));
  const byFile = new Map();
  const refused = [];
  for (const def of moduleDefinitions) {
    const file = moduleCommandFileName(def);
    if (!file) refused.push({ name: def.name, file, reason: "not a module tool name" });
    else if (builtIn.has(file)) refused.push({ name: def.name, file, reason: "matches a built-in command" });
    else byFile.set(file, [...(byFile.get(file) ?? []), def]);
  }
  const stubs = [];
  for (const [file, defs] of byFile) {
    if (defs.length === 1) stubs.push({ file, def: defs[0] });
    else defs.forEach((def) => refused.push({ name: def.name, file, reason: "shared by more than one module tool" }));
  }
  return { stubs, refused };
}

/**
 * Configured tool names that discovery did not return.
 *
 * @param {string[]} configured - Names from local policy.
 * @param {Array<object>} discovered - Definitions from live discovery.
 * @returns {string[]}
 */
export function missingModuleTools(configured, discovered) {
  const found = new Set(discovered.map((def) => def.name));
  return configured.filter((name) => !found.has(name));
}

/** Whether an installed stub was written for a module-owned tool. */
function isModuleStub(path) {
  try {
    return readFileSync(path, "utf8").includes(MODULE_STUB_MARKER);
  } catch {
    return false;
  }
}

/**
 * Write one `drupal-*.md` per tool into each requested client directory,
 * pruning stale stubs first. Unknown client names fail closed.
 *
 * @param {object} [options]
 * @param {string} [options.home] - Install root (default: os.homedir()).
 * @param {string[]} [options.clients] - Subset of CLIENTS keys.
 * @param {Array<object>} [options.definitions]
 * @param {Array<object>} [options.moduleDefinitions] - Module tools from live
 *   discovery. Omitted: installed module stubs are left as they are.
 * @param {boolean} [options.pruneModules=true] - Remove module stubs that are
 *   not rewritten. Pass false when discovery was incomplete.
 * @returns {Array<{client: string, dir: string, written: string[], moduleWritten: string[], catalogued?: number}>}
 */
export function install(options = {}) {
  const home = resolve(options.home || homedir());
  const names = options.clients || DEFAULT_CLIENTS;
  const definitions = options.definitions || allDefinitions;
  const withModules = Array.isArray(options.moduleDefinitions);
  const moduleStubs = withModules ? planModuleStubs(options.moduleDefinitions, definitions).stubs : [];
  const pruneModules = withModules && options.pruneModules !== false;

  const results = [];
  for (const name of names) {
    const client = CLIENTS[name];
    if (!client) {
      throw new Error(`Unknown client "${name}". Allowed: ${Object.keys(CLIENTS).join(", ")}`);
    }
    if (client.kind === "skill") {
      const dir = join(home, client.rel, client.skillName);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, "references"), { recursive: true });
      // The Codex skill is one catalog, so module tools join it rather than
      // getting files of their own. It is rebuilt on every run.
      const catalog = [...definitions, ...moduleStubs.map((stub) => stub.def)];
      writeFileSync(join(dir, "SKILL.md"), client.renderSkill(catalog));
      writeFileSync(join(dir, "references", "tools.md"), client.renderReference(catalog));
      results.push({
        client: name, dir, written: ["SKILL.md", "references/tools.md"],
        catalogued: moduleStubs.length, moduleWritten: [],
      });
      continue;
    }
    const dir = join(home, client.rel);
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!/^drupal-.*\.md$/.test(f)) continue;
      // Module stubs outlive a plain install; only a complete --modules run prunes them.
      if (isModuleStub(join(dir, f)) && !pruneModules) continue;
      rmSync(join(dir, f));
    }
    const written = [];
    for (const def of definitions) {
      const file = commandFileName(def);
      writeFileSync(join(dir, file), client.render(def));
      written.push(file);
    }
    const moduleWritten = [];
    for (const { file, def } of moduleStubs) {
      writeFileSync(join(dir, file), client.render(def));
      moduleWritten.push(file);
    }
    results.push({ client: name, dir, written, moduleWritten });
  }
  return results;
}

/**
 * Discover the module-owned tools the local config approves, as the local
 * operator (no inbound principal). Sources, credentials and governance checks
 * are the ones the server uses; a source that fails returns no tools.
 *
 * @returns {Promise<{definitions: Array<object>, configured: string[]}>}
 */
export async function discoverModuleDefinitions() {
  // Loaded on demand so a plain install needs no site config or network.
  const { loadLocalSecrets } = await import("../src/lib/load-secrets.js");
  const { listResolvableSiteConfigs } = await import("../src/lib/dispatch.js");
  const { createModuleToolRegistry, configuredModuleToolNames } = await import("../src/lib/module-tools.js");
  loadLocalSecrets();
  const sites = listResolvableSiteConfigs();
  const definitions = await createModuleToolRegistry().list({ sites, identity: null });
  return { definitions, configured: configuredModuleToolNames(sites) };
}

const HELP = `Usage: node scripts/install-commands.js [--home DIR] [--clients claude,grok,codex,agents] [--modules]

Copy generated /drupal-* command stubs (and the Codex skill) into operator
home directories. Does not write into a project tree. Does not write
deprecated Codex custom prompts (~/.codex/prompts).

  --home DIR       Install root (default: the current user's home)
  --clients LIST   Comma-separated subset of: claude, grok, codex, agents
                   (default: claude,grok,codex)
  --modules        Also write stubs for module-owned tools. Discovers them from
                   the sources in config/config.json (run from that directory).
                   Without this flag, installed module stubs are left alone.
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
    if (opts.modules) {
      const { definitions, configured } = await discoverModuleDefinitions();
      const missing = missingModuleTools(configured, definitions);
      if (configured.length === 0) {
        console.error("[install-commands] --modules: no site configures serverTools.modules; nothing to discover.");
      }
      if (configured.length > 0 && definitions.length === 0) {
        throw new Error(
          `--modules: ${configured.length} module tools are configured but no source returned any. ` +
          "Check the source, its credentials and its governance status. Nothing was written."
        );
      }
      for (const name of missing) {
        console.error(`[install-commands] WARNING: configured but not returned by its source: ${name}`);
      }
      for (const r of planModuleStubs(definitions).refused) {
        console.error(`[install-commands] WARNING: no stub for ${r.name}: ${r.reason}${r.file ? ` (${r.file})` : ""}`);
      }
      opts.moduleDefinitions = definitions;
      // An incomplete listing must not delete stubs for tools that may only be unreachable.
      opts.pruneModules = missing.length === 0;
    }
    const results = install(opts);
    for (const r of results) {
      const extra = !opts.modules ? ""
        : r.catalogued === undefined ? ` + ${r.moduleWritten.length} module stubs`
          : ` (${r.catalogued} module tools in the catalog)`;
      console.error(`[install-commands] wrote ${r.written.length} files${extra} to ${r.dir} (${r.client})`);
    }
  } catch (err) {
    console.error(`[install-commands] ${err.message}`);
    process.exit(1);
  }
}
