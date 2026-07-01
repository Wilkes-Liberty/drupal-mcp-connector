import { describe, it, expect } from "vitest";

import { allDefinitions, definitionsByName } from "../../src/tools/index.js";
import {
  buildToolPrompts,
  getToolPromptMessages,
  toolNameToPromptName,
  promptNameToToolName,
  paramList,
} from "../../src/lib/tool-prompts.js";

// The 5 hand-authored workflow prompt names (from src/index.js) — the generated
// per-tool prompts must never collide with these.
const WORKFLOW_PROMPT_NAMES = [
  "drupal-content-audit",
  "drupal-create-article",
  "drupal-seo-fix",
  "drupal-user-cleanup",
  "drupal-full-audit",
];

describe("tool-prompts", () => {
  const prompts = buildToolPrompts(allDefinitions);

  it("produces exactly one prompt per tool", () => {
    expect(prompts.length).toBe(allDefinitions.length);
  });

  it("maps tool names to hyphenated prompt names with no underscores", () => {
    expect(toolNameToPromptName("drupal_create_node")).toBe("drupal-create-node");
    expect(promptNameToToolName("drupal-create-node")).toBe("drupal_create_node");
    for (const p of prompts) expect(p.name).not.toContain("_");
  });

  it("generates unique prompt names", () => {
    const names = prompts.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("never collides with the hand-authored workflow prompt names", () => {
    const names = new Set(prompts.map((p) => p.name));
    for (const wf of WORKFLOW_PROMPT_NAMES) expect(names.has(wf)).toBe(false);
  });

  it("carries each tool's required flags onto its prompt arguments", () => {
    for (const def of allDefinitions) {
      const prompt = prompts.find((p) => p.name === toolNameToPromptName(def.name));
      const required = new Set(def.inputSchema?.required ?? []);
      const props = Object.keys(def.inputSchema?.properties ?? {});
      expect(prompt.arguments.map((a) => a.name).sort()).toEqual(props.sort());
      for (const arg of prompt.arguments) {
        expect(arg.required).toBe(required.has(arg.name));
      }
    }
  });

  it("renders a call-the-tool instruction message referencing the raw tool name", () => {
    const messages = getToolPromptMessages("drupal-create-node", { title: "Hi" }, definitionsByName);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content.type).toBe("text");
    const text = messages[0].content.text;
    expect(text).toContain("drupal_create_node");
    // It instructs, it does not itself perform a tool call.
    expect(text).toContain("Make a single call");
    // Supplied args are echoed for the model to use.
    expect(text).toContain('title = "Hi"');
  });

  it("warns on destructive tools", () => {
    const text = getToolPromptMessages("drupal-delete-node", {}, definitionsByName)[0].content.text;
    expect(text).toContain("Destructive");
  });

  it("warns on the generic drupal_entity_delete tool (name-based, not prefix-based)", () => {
    // inferOperation() leaves entity tools "read" (they self-gate in-handler), but the
    // user-facing warning must still fire — see isDestructiveTool in lib/operations.js.
    const text = getToolPromptMessages("drupal-entity-delete", {}, definitionsByName)[0].content.text;
    expect(text).toContain("Destructive");
  });

  it("handles a no-argument tool", () => {
    const listSites = allDefinitions.find((d) => d.name === "drupal_list_sites");
    expect(paramList(listSites.inputSchema)).toEqual([]);
    const prompt = prompts.find((p) => p.name === "drupal-list-sites");
    expect(prompt.arguments).toEqual([]);
    const text = getToolPromptMessages("drupal-list-sites", {}, definitionsByName)[0].content.text;
    expect(text).toContain("takes no arguments");
  });

  it("falls back gracefully for an unknown prompt name", () => {
    const text = getToolPromptMessages("drupal-not-a-tool", {}, definitionsByName)[0].content.text;
    expect(text).toContain("drupal_not_a_tool");
  });
});
