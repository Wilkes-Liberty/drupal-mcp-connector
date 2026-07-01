#!/usr/bin/env node
/**
 * generate-commands.js — generate Claude Code slash commands for every tool.
 *
 * Writes one `.claude/commands/drupal-<tool>.md` per Drupal tool, giving the
 * literal `/drupal-<tool>` slash command in Claude Code (e.g.
 * `/drupal-create-node`). Each file is scoped via `allowed-tools` to only its own
 * `mcp__drupal__<tool>` and instructs the model to parse `$ARGUMENTS` into the
 * tool's parameters before making a single call.
 *
 * Driven from the same tool definitions as the server (src/tools/index.js), so the
 * command set never drifts from the tools. Run: `npm run generate:commands`.
 *
 * Exports `renderCommandMarkdown`, `commandFileName`, and `generate` for tests; the
 * file-writing side effect runs only when executed directly.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync, realpathSync } from "fs";
import { pathToFileURL } from "url";

import { allDefinitions } from "../src/tools/index.js";
import { paramList, toolNameToPromptName } from "../src/lib/tool-prompts.js";
import { isDestructiveTool } from "../src/lib/operations.js";

const COMMANDS_DIR = new URL("../.claude/commands/", import.meta.url);

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
 * @returns {string} File contents (ends with a trailing newline).
 */
export function renderCommandMarkdown(def) {
  const params   = paramList(def.inputSchema);
  const required = params.filter((p) => p.required);
  const optional = params.filter((p) => !p.required);
  const line = (p) => `- \`${p.name}\` (${p.hint})${p.description ? `: ${p.description}` : ""}`;

  const frontmatter = ["---", `description: ${yamlString(def.description)}`];
  if (params.length) frontmatter.push(`argument-hint: ${yamlString(argumentHint(params))}`);
  frontmatter.push(`allowed-tools: mcp__drupal__${def.name}`, "---");

  const body = [`Call the \`mcp__drupal__${def.name}\` MCP tool.`, "", def.description];

  if (isDestructiveTool(def.name)) {
    body.push("", "> ⚠ **Destructive** — this permanently changes or deletes data. Confirm with the user before calling.");
  }

  body.push("");
  if (params.length === 0) {
    body.push("This tool takes no arguments — call it directly (ignore `$ARGUMENTS`).");
  } else {
    body.push("Parse the request in `$ARGUMENTS` into this tool's parameters:", "");
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
      "If a required parameter is missing from `$ARGUMENTS`, ask before calling — do not " +
      "invent values. Coerce each value to its JSON type (booleans → true/false, numbers → " +
      "numeric, object/array → parse JSON), then make the single tool call and summarize the result."
    );
  }

  return `${frontmatter.join("\n")}\n\n${body.join("\n")}\n`;
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
  console.error(`[generate-commands] wrote ${written.length} command files to .claude/commands/`);
}
