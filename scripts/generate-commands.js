#!/usr/bin/env node
/**
 * generate-commands.js — generate harness-agnostic slash-command stubs for every tool.
 *
 * Writes one `.agents/commands/drupal-<tool>.md` per Drupal tool. The files use
 * protocol tool names (`drupal_list_nodes`) so any MCP client can consume them;
 * they are not a vendor rule tree. Clients that scan `.agents/commands/` (Grok
 * Build, when this repo is the project) pick them up as `/drupal-<tool>`.
 *
 * Clients that only scan a vendor home directory (Claude Code `~/.claude/commands`,
 * Grok `~/.grok/commands`) get the same files via `npm run install:commands`.
 *
 * Driven from the same tool definitions as the server (src/tools/index.js), so the
 * command set never drifts from the tools. Run: `npm run generate:commands`.
 *
 * Exports `renderCommandMarkdown`, `renderClaudeCommandMarkdown`, `commandFileName`,
 * `COMMANDS_DIR`, and `generate` for tests; the file-writing side effect runs only
 * when executed directly.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync, realpathSync } from "fs";
import { pathToFileURL } from "url";

import { allDefinitions } from "../src/tools/index.js";
import { paramList, toolNameToPromptName } from "../src/lib/tool-prompts.js";
import { isDestructiveTool } from "../src/lib/operations.js";

/** Canonical, harness-agnostic command tree shipped in the repo and the npm package. */
export const COMMANDS_DIR = new URL("../.agents/commands/", import.meta.url);

/** Map a tool definition to its command filename: `drupal_create_node` → `drupal-create-node.md`. */
export function commandFileName(def) {
  return `${toolNameToPromptName(def.name)}.md`;
}

/** Collapse to a single-line, double-quoted YAML scalar. */
function yamlString(value) {
  const clean = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
  return `"${clean}"`;
}

/** Build the `argument-hint` string: `<required>` first, then `[optional]` (order stable within each group). */
function argumentHint(params) {
  const ordered = [...params].sort((a, b) => Number(b.required) - Number(a.required));
  return ordered.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(" ");
}

/**
 * Render the markdown for one tool's slash command.
 *
 * @param {object} def - The tool definition ({name, description, inputSchema}).
 * @param {object} [options]
 * @param {string} [options.allowedTools] - Optional Claude Code `allowed-tools` value.
 * @param {string} [options.argumentsPhrase="the arguments supplied with this command"]
 *   Phrase used in the parse-arguments instruction. Claude Code install rewrites
 *   this to `` `$ARGUMENTS` `` because that client substitutes the placeholder.
 * @returns {string} File contents (ends with a trailing newline).
 */
export function renderCommandMarkdown(def, options = {}) {
  const params   = paramList(def.inputSchema);
  const required = params.filter((p) => p.required);
  const optional = params.filter((p) => !p.required);
  const line = (p) => `- \`${p.name}\` (${p.hint})${p.description ? `: ${p.description}` : ""}`;
  const argumentsPhrase = options.argumentsPhrase ?? "the arguments supplied with this command";

  const frontmatter = ["---", `description: ${yamlString(def.description)}`];
  if (params.length) frontmatter.push(`argument-hint: ${yamlString(argumentHint(params))}`);
  if (options.allowedTools) frontmatter.push(`allowed-tools: ${options.allowedTools}`);
  frontmatter.push("---");

  const body = [`Call the MCP tool \`${def.name}\`.`, "", def.description];

  if (isDestructiveTool(def.name)) {
    body.push("", "> ⚠ **Destructive** — this permanently changes or deletes data. Confirm with the user before calling.");
  }

  body.push("");
  if (params.length === 0) {
    body.push("This tool takes no arguments — call it directly.");
  } else {
    body.push(`Parse ${argumentsPhrase} into this tool's parameters:`, "");
    if (required.length) {
      body.push("**Required:**");
      required.forEach((p) => body.push(line(p)));
      body.push("");
    }
    if (optional.length) {
      body.push("**Optional:**");
      optional.forEach((p) => body.push(line(p)));
      body.push("");
    }
    body.push(
      "If a required parameter is missing, ask before calling — do not invent values. " +
      "Coerce each value to its JSON type (booleans → true/false, numbers → numeric, " +
      "object/array → parse JSON), then make the single tool call and summarize the result."
    );
  }

  return `${frontmatter.join("\n")}\n\n${body.join("\n")}\n`;
}

/**
 * Claude Code adapter: same stub plus `allowed-tools` scoped to that client's
 * MCP tool name, and `$ARGUMENTS` so typed `/drupal-*` args are not dropped.
 *
 * @param {object} def - The tool definition.
 * @returns {string} File contents.
 */
export function renderClaudeCommandMarkdown(def) {
  return renderCommandMarkdown(def, {
    allowedTools: `mcp__drupal__${def.name}`,
    argumentsPhrase: "`$ARGUMENTS`",
  });
}

/**
 * Write one command file per tool, pruning stale `drupal-*.md` first so removed
 * tools leave no orphans.
 *
 * @param {Array<object>} [definitions] - Tool definitions (defaults to allDefinitions).
 * @returns {string[]} The filenames written.
 */
export function generate(definitions = allDefinitions) {
  mkdirSync(COMMANDS_DIR, { recursive: true });
  for (const f of readdirSync(COMMANDS_DIR)) {
    if (/^drupal-.*\.md$/.test(f)) rmSync(new URL(f, COMMANDS_DIR));
  }
  const written = [];
  for (const def of definitions) {
    const file = commandFileName(def);
    writeFileSync(new URL(file, COMMANDS_DIR), renderCommandMarkdown(def));
    written.push(file);
  }
  return written;
}

// Run the write only when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const written = generate();
  console.error(`[generate-commands] wrote ${written.length} command files to .agents/commands/`);
}
