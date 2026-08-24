import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "fs";

import { allDefinitions } from "../../src/tools/index.js";
import {
  renderCommandMarkdown,
  renderClaudeCommandMarkdown,
  commandFileName,
  COMMANDS_DIR,
} from "../../scripts/generate-commands.js";

/** Extract the YAML frontmatter block into a flat key→value map. */
function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^"|"$/g, "");
  }
  return out;
}

describe("generate-commands", () => {
  it("renders one file per tool with a unique, correctly-mapped filename", () => {
    const names = allDefinitions.map(commandFileName);
    expect(new Set(names).size).toBe(names.length);
    expect(commandFileName({ name: "drupal_create_node" })).toBe("drupal-create-node.md");
  });

  it("emits harness-agnostic frontmatter (protocol tool name, no vendor allowed-tools)", () => {
    for (const def of allDefinitions) {
      const md = renderCommandMarkdown(def);
      const fm = parseFrontmatter(md);
      expect(fm).not.toBeNull();
      expect(fm.description).toBeTruthy();
      expect(fm["allowed-tools"]).toBeUndefined();
      expect(md).toContain(`Call the MCP tool \`${def.name}\`.`);
      expect(md).not.toMatch(/mcp__/);
      const hasParams = Object.keys(def.inputSchema?.properties ?? {}).length > 0;
      expect("argument-hint" in fm).toBe(hasParams);
      if (hasParams) {
        expect(md).toContain("the arguments supplied with this command");
        expect(md).not.toContain("$ARGUMENTS");
      }
    }
  });

  it("Claude adapter scopes allowed-tools and substitutes $ARGUMENTS", () => {
    const def = allDefinitions.find((d) => d.name === "drupal_list_nodes");
    expect(def).toBeTruthy();
    const md = renderClaudeCommandMarkdown(def);
    const fm = parseFrontmatter(md);
    expect(fm["allowed-tools"]).toBe("mcp__drupal__drupal_list_nodes");
    expect(md).toContain("`$ARGUMENTS`");
    expect(md).toContain("Call the MCP tool `drupal_list_nodes`.");
  });

  it("keeps the committed .agents/commands in sync with the tools (run `npm run generate:commands`)", () => {
    const onDisk = readdirSync(COMMANDS_DIR).filter((f) => /^drupal-.*\.md$/.test(f)).sort();
    const expected = allDefinitions.map(commandFileName).sort();
    expect(onDisk).toEqual(expected);

    for (const def of allDefinitions) {
      const file = new URL(commandFileName(def), COMMANDS_DIR);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(renderCommandMarkdown(def));
    }
  });
});
