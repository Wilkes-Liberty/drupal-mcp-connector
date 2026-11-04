import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { allDefinitions } from "../../src/tools/index.js";
import { builtinWorkflowProvider } from "../../src/lib/workflows/builtin.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Every src/tools/*.js file except the aggregator is one public tool module.
const toolModuleFiles = readdirSync(join(root, "src/tools"))
  .filter((name) => name.endsWith(".js") && name !== "index.js");

const toolCount = allDefinitions.length;
const moduleCount = toolModuleFiles.length;
const workflowCount = builtinWorkflowProvider.workflows.length;
const promptCount = toolCount + workflowCount;

// Public surfaces that froze 123/27/128 after nested.js landed (#421).
const catalogDocs = [
  "README.md",
  "docs/tools-reference.md",
  "docs/architecture.md",
  "docs/whitepaper.md",
];

/**
 * @param {string} rel
 * @returns {string}
 */
function readRepoFile(rel) {
  return readFileSync(join(root, rel), "utf8");
}

describe("public catalog counts", () => {
  it("exposes the live tool, module, and workflow catalog", () => {
    // Pin against the registry, not a hardcoded marketing number, so a new
    // tool fails the docs assertions below instead of this one.
    expect(toolCount).toBeGreaterThan(0);
    expect(moduleCount).toBe(new Set(toolModuleFiles).size);
    expect(toolModuleFiles).toContain("nested.js");
    expect(allDefinitions.some((def) => def.name === "drupal_draft_nested_components")).toBe(true);
    expect(workflowCount).toBe(5);
    expect(builtinWorkflowProvider.workflows.map((workflow) => workflow.name))
      .toContain("drupal-full-audit");
    expect(promptCount).toBe(toolCount + workflowCount);
  });

  it("prints the live totals in the public catalog docs", () => {
    const toolRe = new RegExp(String.raw`\b${toolCount} tools?\b`, "i");
    const moduleRe = new RegExp(String.raw`\b${moduleCount} modules?\b`, "i");
    const promptRe = new RegExp(String.raw`\b${promptCount} MCP prompts?\b`, "i");

    for (const rel of catalogDocs) {
      const text = readRepoFile(rel);
      expect(text, rel).toMatch(toolRe);
    }

    // Architecture names the tool total in the diagram and prose, not modules.
    expect(readRepoFile("README.md")).toMatch(moduleRe);
    expect(readRepoFile("docs/tools-reference.md")).toMatch(moduleRe);
    expect(readRepoFile("docs/whitepaper.md")).toMatch(moduleRe);
    expect(readRepoFile("docs/whitepaper.md")).toMatch(promptRe);
  });

  it("names Nested and the fifth builtin workflow on the public surfaces", () => {
    const readme = readRepoFile("README.md");
    const toolsRef = readRepoFile("docs/tools-reference.md");
    const architecture = readRepoFile("docs/architecture.md");

    expect(readme).toMatch(/\*\*Nested\*\*/);
    expect(readme).toContain("drupal_draft_nested_components");
    expect(toolsRef).toMatch(/\[Nested\]\(#nested\)/);
    expect(toolsRef).toContain("## Nested");
    expect(architecture).toContain("`drupal-full-audit`");
  });
});
