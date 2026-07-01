import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "fs";

import { allDefinitions } from "../../src/tools/index.js";
import { renderCommandMarkdown, commandFileName } from "../../scripts/generate-commands.js";

const COMMANDS_DIR = new URL("../../.claude/commands/", import.meta.url);

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

  it("emits valid frontmatter scoped to exactly the one tool", () => {
    for (const def of allDefinitions) {
      const fm = parseFrontmatter(renderCommandMarkdown(def));
      expect(fm).not.toBeNull();
      expect(fm.description).toBeTruthy();
      expect(fm["allowed-tools"]).toBe(`mcp__drupal__${def.name}`);
      // argument-hint present iff the tool has parameters
      const hasParams = Object.keys(def.inputSchema?.properties ?? {}).length > 0;
      expect("argument-hint" in fm).toBe(hasParams);
    }
  });

  it("keeps the committed .claude/commands in sync with the tools (run `npm run generate:commands`)", () => {
    const onDisk = readdirSync(COMMANDS_DIR).filter((f) => /^drupal-.*\.md$/.test(f)).sort();
    const expected = allDefinitions.map(commandFileName).sort();
    expect(onDisk).toEqual(expected);

    // Byte-for-byte: every committed file must match a fresh render of its tool.
    for (const def of allDefinitions) {
      const file = new URL(commandFileName(def), COMMANDS_DIR);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(renderCommandMarkdown(def));
    }
  });
});
