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

import { inferOperation, isDestructiveTool } from "./operations.js";
import { SITE_PARAM } from "./site-target.js";

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
function typeHint(spec) {
  const t = Array.isArray(spec?.type) ? spec.type[0] : spec?.type;
  // A short closed list is the most useful thing to show for a string choice.
  if (Array.isArray(spec?.enum) && spec.enum.length > 0 && spec.enum.length <= 12 &&
      spec.enum.every((v) => typeof v === "string" && v.length <= 40)) {
    return `one of: ${spec.enum.join(", ")}`;
  }
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
    description: spec?.description || (name === "site" ? SITE_PARAM.description : ""),
  }));
}

/**
 * Whether a definition came from the module registry (src/lib/module-tools.js).
 * Those names are reserved, so the prefix alone identifies them.
 *
 * @param {object} def - A tool definition.
 * @returns {boolean}
 */
export const isModuleDefinition = (def) =>
  typeof def?.name === "string" && def.name.startsWith("drupal_module_");

/** Longest source-supplied description kept in a prompt or stub. */
const SOURCE_TEXT_LIMIT = 1024;

/**
 * Flatten and bound text that a Drupal source supplied. It ends up in
 * instruction text and in files on the operator's disk, so it stays on one
 * line where it cannot start a heading, a rule or a block of its own.
 *
 * @param {*} value - Source-supplied text.
 * @returns {string}
 */
export function sourceText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, SOURCE_TEXT_LIMIT);
}

/**
 * A tool's description as prompts and stubs should show it. Built-in text is
 * authored in this repo and is returned as written.
 *
 * @param {object} def - A tool definition.
 * @returns {string}
 */
export function toolDescription(def) {
  return isModuleDefinition(def) ? sourceText(def.description) : def.description;
}

/**
 * Parameter catalog a person fills in for a tool. A module-owned tool wraps the
 * module's schema in a `{ catalogRevision, arguments }` envelope, so its
 * parameters are the properties of `arguments`, not of the envelope.
 *
 * @param {object} def - A tool definition.
 * @returns {Array<{name:string, required:boolean, hint:string, description:string}>}
 */
export function toolParams(def) {
  if (!isModuleDefinition(def)) return paramList(def.inputSchema);
  return paramList(def.inputSchema?.properties?.arguments)
    .map((param) => ({ ...param, description: sourceText(param.description) }));
}

/**
 * Call-shape guidance shared by module tool prompts and command stubs. The
 * revision changes with the module's schema, so text never embeds its value.
 *
 * @param {object} def - A module tool definition.
 * @param {boolean} hasParams - Whether the module declares any parameters.
 * @returns {string[]} Lines to append to the instruction.
 */
export function moduleCallNotes(def, hasParams) {
  const notes = [
    "This is a module-owned tool. Its input has exactly two properties: `catalogRevision` and `arguments`.",
    hasParams
      ? "Put the parameters above inside `arguments`."
      : "Pass an empty `arguments` object.",
    "Copy `catalogRevision` from the constant in this tool's current input schema. " +
    "If the call reports a changed schema, refresh the tool list and use the new value.",
  ];
  if (inferOperation(def.name) !== "read") {
    notes.push("Do not retry a write after an uncertain result. Report it so the outcome can be checked first.");
  }
  return notes;
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
    description: `Invoke the ${def.name} tool. ${toolDescription(def)}`.slice(0, 300),
    arguments: toolParams(def).map((p) => ({
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
function renderToolInstruction(def, args = {}) {
  const params   = toolParams(def);
  const required = params.filter((p) => p.required);
  const optional = params.filter((p) => !p.required);
  const line = (p) => `- ${p.name} (${p.hint})${p.description ? `: ${p.description}` : ""}`;
  const isModule = isModuleDefinition(def);

  const out = [`Call the MCP tool \`${def.name}\`.`, "", toolDescription(def)];

  if (isDestructiveTool(def.name)) {
    out.push("", "⚠ Destructive: this permanently changes or deletes data. Confirm with the user before calling.");
  }

  out.push("");
  if (params.length === 0) {
    out.push(isModule ? "This tool takes no parameters." : "This tool takes no arguments — call it directly.");
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

  if (isModule) out.push("", ...moduleCallNotes(def, params.length > 0));

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

/**
 * Compose the server's prompt surface from the static prompts and the module
 * tools that live discovery returns for this request. Module prompts inherit
 * discovery's caller, site and source checks; nothing is cached across requests.
 *
 * @param {object} options
 * @param {Array<object>} options.staticPrompts - Workflow prompts plus built-in tool prompts.
 * @param {() => Promise<Array<object>>} options.discover - Tools visible to the current request.
 * @param {(prompts: Array<object>, tools: Array<object>) => Array<object>} options.filter
 *   Principal filter for the static prompts.
 * @param {Set<string>} options.workflowNames - Names of the hand-authored workflow prompts.
 * @param {(name: string, args: object) => Array<object>} options.workflowMessages
 * @param {Map<string,object>} options.definitionsByName - Built-in tool name → definition.
 * @param {(tools: Array<object>, taken: Set<string>) => object[]} [options.extraWorkflows]
 *   Module-owned workflows visible for this request. Each item has name,
 *   description, arguments, and is renderable by extraWorkflowMessages.
 * @param {(workflow: object, args: object) => Array<object>} [options.extraWorkflowMessages]
 * @returns {{definitions: Array<object>, list: Function, describe: Function, get: Function}}
 */
export function createPromptSurface({
  staticPrompts, discover, filter, workflowNames, workflowMessages, definitionsByName,
  extraWorkflows, extraWorkflowMessages,
}) {
  const get = (name, args) => workflowNames.has(name)
    ? workflowMessages(name, args)
    : getToolPromptMessages(name, args, definitionsByName);

  async function visible() {
    const tools = await discover();
    const taken = new Set(staticPrompts.map((prompt) => prompt.name));
    const extra = extraWorkflows ? extraWorkflows(tools, taken) : [];
    for (const workflow of extra) taken.add(workflow.name);
    // A reserved module name cannot match a built-in, but never let a remote
    // catalog shadow a static prompt if that invariant is ever broken.
    const moduleDefs = tools.filter((tool) =>
      isModuleDefinition(tool) && !taken.has(toolNameToPromptName(tool.name)));
    const extraPrompts = extra.map((workflow) => ({
      name: workflow.name,
      description: workflow.description,
      arguments: workflow.arguments,
    }));
    return {
      prompts: [...filter([...staticPrompts, ...extraPrompts], tools), ...buildToolPrompts(moduleDefs)],
      moduleDefs,
      extra,
    };
  }

  return {
    definitions: staticPrompts,
    get,
    list: async () => (await visible()).prompts,
    /** Resolve one prompt, or null when it is not visible to this request. */
    async describe(name, args = {}) {
      const { prompts, moduleDefs, extra } = await visible();
      const known = prompts.find((prompt) => prompt.name === name);
      if (!known) return null;
      const live = moduleDefs.find((def) => toolNameToPromptName(def.name) === name);
      if (live) {
        return {
          description: known.description,
          messages: getToolPromptMessages(name, args, new Map([[live.name, live]])),
        };
      }
      const workflow = extra.find((item) => item.name === name);
      if (workflow && extraWorkflowMessages) {
        return { description: known.description, messages: extraWorkflowMessages(workflow, args) };
      }
      return { description: known.description, messages: get(name, args) };
    },
  };
}
