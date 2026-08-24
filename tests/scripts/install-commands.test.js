import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { allDefinitions } from "../../src/tools/index.js";
import {
  renderCommandMarkdown,
  renderClaudeCommandMarkdown,
  commandFileName,
} from "../../scripts/generate-commands.js";
import { install, parseArgs, CLIENTS } from "../../scripts/install-commands.js";

const defs = [
  {
    name: "drupal_list_nodes",
    description: "List nodes.",
    inputSchema: { type: "object", required: ["type"], properties: { type: { type: "string" } } },
  },
  {
    name: "drupal_list_sites",
    description: "List sites.",
    inputSchema: { type: "object", properties: {} },
  },
];

describe("install-commands", () => {
  it("parses --home and --clients", () => {
    expect(parseArgs(["--home", "/tmp/x", "--clients", "claude"])).toEqual({
      home: "/tmp/x",
      clients: ["claude"],
    });
    expect(parseArgs(["--home=/tmp/y", "--clients=grok,agents"]).home).toBe("/tmp/y");
    expect(parseArgs([]).clients).toEqual(["claude", "grok"]);
  });

  it("rejects unknown flags and unknown clients", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
    const home = mkdtempSync(join(tmpdir(), "dmc-install-"));
    expect(() => install({ home, clients: ["cursor"], definitions: defs })).toThrow(/Unknown client/);
  });

  it("writes Claude-adapted and canonical stubs under --home and prunes stale drupal-*.md", () => {
    const home = mkdtempSync(join(tmpdir(), "dmc-install-"));
    const claudeDir = join(home, ".claude", "commands");
    const grokDir = join(home, ".grok", "commands");

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "drupal-stale-gone.md"), "stale");
    writeFileSync(join(claudeDir, "not-ours.md"), "leave me");

    const results = install({ home, clients: ["claude", "grok"], definitions: defs });
    expect(results.map((r) => r.client)).toEqual(["claude", "grok"]);

    expect(existsSync(join(claudeDir, "drupal-stale-gone.md"))).toBe(false);
    expect(readFileSync(join(claudeDir, "not-ours.md"), "utf8")).toBe("leave me");

    const expected = defs.map(commandFileName).sort();
    expect(readdirSync(claudeDir).filter((f) => /^drupal-.*\.md$/.test(f)).sort()).toEqual(expected);
    expect(readdirSync(grokDir).filter((f) => /^drupal-.*\.md$/.test(f)).sort()).toEqual(expected);

    expect(readFileSync(join(claudeDir, "drupal-list-nodes.md"), "utf8"))
      .toBe(renderClaudeCommandMarkdown(defs[0]));
    expect(readFileSync(join(grokDir, "drupal-list-nodes.md"), "utf8"))
      .toBe(renderCommandMarkdown(defs[0]));
  });

  it("default client map covers claude, grok, and agents", () => {
    expect(Object.keys(CLIENTS).sort()).toEqual(["agents", "claude", "grok"]);
    expect(allDefinitions.length).toBeGreaterThan(0);
  });
});
