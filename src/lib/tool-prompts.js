/**
 * Per-tool MCP prompts (Surface A).
 *
 * Every Drupal tool is exposed as an MCP prompt so it can be invoked as a
 * slash command in any MCP client (in Claude Code these render as
 * `/mcp__drupal__drupal-create-node`). Prompts are derived dynamically from the
 * aggregated tool definitions (src/tools/index.js) at server startup, so the set
 * always matches the tools with no hand-maintained list.
 *
 * A prompt does not (and cannot) call a tool itself — it returns an instruction
 * message telling the model to call the underlying `drupal_*` tool with the
 * supplied arguments. MCP prompt arguments are strings by protocol, so the
 * instruction tells the model how to coerce each value to the parameter's real
 * JSON type.
 */

import { isDestructiveTool } from "./operations.js";

/** Convert a tool name to its prompt/command name: `drupal_create_node` → `drupal-create-node`. */
export const toolNameToPromptName = (name) => name.replace(/_/g, "-");

/** Reverse of {@link toolNameToPromptName}: `drupal-create-node` → `drupal_create_node`. */
export const promptNameToToolName = (name) => name.replace(/-/g, "_");

/**
 * Human-readable type hint with coercion guidance for a schema property.
 *
 * @param {object} spec - A JSON-Schema property spec.
 * @returns {string} e.g. "string", "boolean (true/false)", "object (pass as JSON)".
 */
export function typeHint(spec) {
  const t = Array.isArray(spec?.type) ? spec.type[0] : spec?.type;
  switch (t) {
    case "boolean":       return "boolean (true/false)";
    case "number":
    case "integer":       return "number";
    case "array":         return "array (pass as JSON)";
    case "object":        return "object (pass as JSON)";
    default:              return "string";
  }
}

/**
 * Flatten a tool's inputSchema into a parameter catalog shared by both the prompt
 * text and the generated command markdown.
 *
 * @param {object} inputSchema - The tool's JSON-Schema input object.
 * @returns {Array<{name:string, required:boolean, hint:string, description:string}>}
 */
export function paramList(inputSchema) {
  const props = inputSchema?.properties ?? {};
  const required = new Set(inputSchema?.required ?? []);
  return Object.entries(props).map(([name, spec]) => ({
    name,
    required: required.has(name),
    hint: typeHint(spec),
    description: spec?.description || (name === "site" ? "omit for the default site" : ""),
  }));
}

/**
 * Build one MCP prompt descriptor per tool definition.
 *
 * @param {Array<object>} definitions - Tool definitions ({name, description, inputSchema}).
 * @returns {Array<{name:string, description:string, arguments:Array<object>}>}
 */
export function buildToolPrompts(definitions) {
  return definitions.map((def) => ({
    name: toolNameToPromptName(def.name),
    description: `Invoke the ${def.name} tool. ${def.description}`.slice(0, 300),
    arguments: paramList(def.inputSchema).map((p) => ({
      name: p.name,
      description: p.description ? `${p.hint} — ${p.description}` : p.hint,
      required: p.required,
    })),
  }));
}

/**
 * Render the instruction text that tells the model to call a tool.
 *
 * @param {object} def  - The tool definition.
 * @param {object} args - Arguments supplied to the prompt (all strings per MCP).
 * @returns {string} A user-role instruction message body.
 */
export function renderToolInstruction(def, args = {}) {
  const params   = paramList(def.inputSchema);
  const required = params.filter((p) => p.required);
  const optional = params.filter((p) => !p.required);
  const line = (p) => `- ${p.name} (${p.hint})${p.description ? `: ${p.description}` : ""}`;

  const out = [`Call the MCP tool \`${def.name}\`.`, "", def.description];

  if (isDestructiveTool(def.name)) {
    out.push("", "⚠ Destructive: this permanently changes or deletes data. Confirm with the user before calling.");
  }

  out.push("");
  if (params.length === 0) {
    out.push("This tool takes no arguments — call it directly.");
  } else {
    if (required.length) {
      out.push("Required parameters (ask me for any that are missing — do not invent values):");
      required.forEach((p) => out.push(line(p)));
    } else {
      out.push("All parameters are optional.");
    }
    if (optional.length) {
      out.push("", required.length ? "Optional parameters:" : "Parameters:");
      optional.forEach((p) => out.push(line(p)));
    }
  }

  const supplied = Object.entries(args ?? {}).filter(([, v]) => v !== undefined && v !== "");
  if (supplied.length) {
    out.push("", "Values I supplied:");
    supplied.forEach(([k, v]) => out.push(`- ${k} = ${JSON.stringify(v)}`));
  }

  out.push(
    "",
    "Coerce each value to the parameter's JSON type (booleans → true/false, numbers → " +
    "numeric, object/array → parse JSON). Make a single call to this tool, then summarize " +
    "the result. Do not call any other tool."
  );
  return out.join("\n");
}

/**
 * Build the MCP prompt messages for a per-tool prompt.
 *
 * @param {string} promptName       - The prompt name (e.g. "drupal-create-node").
 * @param {object} args             - Prompt arguments.
 * @param {Map<string,object>} definitionsByName - Tool name → definition lookup.
 * @returns {Array<object>} MCP prompt messages.
 */
export function getToolPromptMessages(promptName, args = {}, definitionsByName) {
  const toolName = promptNameToToolName(promptName);
  const def = definitionsByName.get(toolName);
  if (!def) {
    return [{ role: "user", content: { type: "text",
      text: `Call the MCP tool \`${toolName}\` to fulfill this request.` } }];
  }
  return [{ role: "user", content: { type: "text", text: renderToolInstruction(def, args) } }];
}
