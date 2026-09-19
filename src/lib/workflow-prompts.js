/**
 * Module-owned and built-in workflow prompts (#333).
 *
 * A workflow is a definition (id, tools, instructions) from a provider. The
 * loader validates, bounds, and filters. It does not call tools. See
 * docs/module-workflows.md.
 */

import { sourceText, toolNameToPromptName } from "./tool-prompts.js";

const ID_RE = /^[a-z][a-z0-9_]{0,47}$/;
const ARG_RE = /^[a-z][a-z0-9_]{0,47}$/;
const MAX_DESCRIPTION = 1024;
const MAX_INSTRUCTIONS = 8192;
const MAX_ARG_VALUE = 200;
const MAX_WORKFLOWS = 64;
const MAX_TOOLS = 32;
const MAX_ARGUMENTS = 16;
const WRITE_EPILOGUE = "Module writes are not retried.";

/**
 * Public MCP prompt name for a module workflow.
 *
 * @param {string} namespace
 * @param {string} id
 * @returns {string}
 */
export function workflowPromptName(namespace, id) {
  return `drupal-${String(namespace).replace(/_/g, "-")}-${String(id).replace(/_/g, "-")}`;
}

/**
 * Instruction text safe to hand to a model: no heading, no system: prefix.
 *
 * @param {*} value
 * @param {number} [limit]
 * @returns {string}
 */
export function sanitizeInstructions(value, limit = MAX_INSTRUCTIONS) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*system\s*:/gim, "")
    .trim()
    .slice(0, limit);
}

function sanitizeArgValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_ARG_VALUE);
}

/**
 * Validate one definition. Throws if it cannot be loaded.
 *
 * @param {object} raw
 * @returns {object}
 */
export function normalizeWorkflow(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Workflow definition must be an object.");
  }
  if (!ID_RE.test(raw.id ?? "")) throw new Error("Invalid workflow id.");
  if (typeof raw.description !== "string" || !raw.description.trim()) {
    throw new Error("Workflow description is required.");
  }
  if (typeof raw.readOnly !== "boolean") throw new Error("Workflow readOnly is required.");
  if (!Array.isArray(raw.tools) || raw.tools.length < 1 || raw.tools.length > MAX_TOOLS) {
    throw new Error("Workflow tools must be a non-empty list.");
  }
  if (raw.tools.some((alias) => !ID_RE.test(alias ?? ""))) {
    throw new Error("Invalid workflow tool alias.");
  }
  if (new Set(raw.tools).size !== raw.tools.length) {
    throw new Error("Workflow tools must be unique.");
  }
  if (typeof raw.instructions !== "string" || !raw.instructions.trim()) {
    throw new Error("Workflow instructions are required.");
  }
  const args = Array.isArray(raw.arguments) ? raw.arguments : [];
  if (args.length > MAX_ARGUMENTS) throw new Error("Too many workflow arguments.");
  const arguments_ = [];
  for (const arg of args) {
    if (!arg || !ARG_RE.test(arg.name ?? "") || typeof arg.description !== "string") {
      throw new Error("Invalid workflow argument.");
    }
    arguments_.push({
      name: arg.name,
      description: sourceText(arg.description),
      required: Boolean(arg.required),
    });
  }
  const placeholders = [...raw.instructions.matchAll(/\{tool:([a-z][a-z0-9_]{0,47})\}/g)].map((m) => m[1]);
  for (const alias of placeholders) {
    if (!raw.tools.includes(alias)) {
      throw new Error("Workflow instructions name a tool that is not in tools.");
    }
  }
  return {
    id: raw.id,
    description: sourceText(raw.description),
    readOnly: raw.readOnly,
    tools: [...raw.tools],
    arguments: arguments_,
    instructions: sanitizeInstructions(raw.instructions),
    name: typeof raw.name === "string" && raw.name ? raw.name : undefined,
  };
}

/**
 * @param {object} def
 * @param {string} namespace
 * @returns {string}
 */
export function resolvedName(def, namespace) {
  return def.name || workflowPromptName(namespace, def.id);
}

/**
 * Map a local alias to the public module tool name using the live tool list.
 *
 * @param {string} namespace
 * @param {string} alias
 * @param {Array<{name: string}>} tools
 * @returns {string|null}
 */
export function publicToolName(namespace, alias, tools) {
  const suffix = `_${namespace}__${alias}`;
  const found = (tools ?? []).filter((tool) =>
    typeof tool?.name === "string" &&
    tool.name.startsWith("drupal_module_") &&
    tool.name.endsWith(suffix));
  return found.length === 1 ? found[0].name : null;
}

/**
 * Whether every named tool is visible. Built-in public names must match
 * exactly; module aliases resolve through {@link publicToolName}.
 *
 * @param {object} def
 * @param {string} namespace
 * @param {Array<{name: string}>} tools
 * @param {{builtin?: boolean}} [opts]
 * @returns {string[]|null} Public names, or null when any tool is missing.
 */
export function resolveToolNames(def, namespace, tools, opts = {}) {
  const visible = new Set((tools ?? []).map((tool) => tool.name));
  const names = [];
  for (const alias of def.tools) {
    const publicName = opts.builtin
      ? (visible.has(alias) ? alias : null)
      : publicToolName(namespace, alias, tools);
    if (!publicName) return null;
    names.push(publicName);
  }
  return names;
}

/**
 * Load workflows from providers. Each provider is
 * `{ id, namespace, builtin?, workflows }` or a function returning that.
 *
 * Two unrelated providers are the intended test shape: a CRM-like catalog and
 * an intake-like catalog must not leak into each other.
 *
 * @param {Array<object|Function>} providers
 * @param {object} [context]
 * @param {Array<{name: string}>} [context.tools]
 * @param {Set<string>} [context.taken]
 * @returns {object[]} Loaded, visible workflows.
 */
export function loadWorkflows(providers, context = {}) {
  const tools = context.tools ?? [];
  const taken = new Set(context.taken ?? []);
  const out = [];
  for (const rawProvider of providers) {
    const provider = typeof rawProvider === "function" ? rawProvider() : rawProvider;
    if (!provider || typeof provider.namespace !== "string") continue;
    if (!provider.builtin && !/^[a-z][a-z0-9_]{0,23}$/.test(provider.namespace ?? "")) {
      continue;
    }
    const list = Array.isArray(provider.workflows) ? provider.workflows : [];
    let n = 0;
    for (const raw of list) {
      if (n >= MAX_WORKFLOWS) break;
      let def;
      try {
        def = normalizeWorkflow(raw);
      } catch {
        continue;
      }
      n += 1;
      const name = resolvedName(def, provider.namespace);
      if (taken.has(name) || (!provider.builtin && name !== workflowPromptName(provider.namespace, def.id))) {
        continue;
      }
      const publicNames = resolveToolNames(def, provider.namespace, tools, { builtin: Boolean(provider.builtin) });
      if (!publicNames) continue;
      taken.add(name);
      out.push({
        ...def,
        name,
        namespace: provider.namespace,
        builtin: Boolean(provider.builtin),
        publicTools: publicNames,
      });
    }
  }
  return out;
}

/**
 * MCP prompt descriptor (no internal fields).
 *
 * @param {object} workflow
 * @returns {object}
 */
export function toPromptDescriptor(workflow) {
  return {
    name: workflow.name,
    description: workflow.description,
    arguments: workflow.arguments.map((arg) => ({
      name: arg.name,
      description: arg.description,
      required: arg.required,
    })),
  };
}

function builtinArgValues(args) {
  const site = sanitizeArgValue(args?.site);
  return {
    site_phrase: site ? `on the "${site}" site` : "on the default site",
    type: sanitizeArgValue(args?.type) || "article",
    topic: sanitizeArgValue(args?.topic) || "the requested topic",
    site,
  };
}

/**
 * Render MCP messages for a loaded workflow.
 *
 * @param {object} workflow
 * @param {object} [args]
 * @returns {Array<object>}
 */
export function renderWorkflowMessages(workflow, args = {}) {
  const publicTools = [...(workflow.publicTools ?? [])];
  const toolMap = new Map();
  workflow.tools.forEach((alias, index) => {
    toolMap.set(alias, publicTools.at(index));
  });
  const argMap = new Map(Object.entries(builtinArgValues(args)));
  for (const arg of workflow.arguments) {
    if (arg.name !== "site_phrase" && Object.hasOwn(args, arg.name)) {
      argMap.set(arg.name, sanitizeArgValue(args[arg.name]));
    }
  }
  let text = workflow.instructions.replace(/\{tool:([a-z][a-z0-9_]{0,47})\}/g, (_, alias) => {
    return toolMap.get(alias) || `{tool:${alias}}`;
  });
  text = text.replace(/\{arg:([a-z][a-z0-9_]{0,47})\}/g, (_, name) => argMap.get(name) ?? "");
  if (!workflow.readOnly) {
    text = `${text}\n${WRITE_EPILOGUE}`;
  }
  return [{ role: "user", content: { type: "text", text } }];
}

/**
 * Provider from site `serverTools.modules.workflows` maps.
 *
 * @param {Array<object>} sites
 * @returns {Array<object>}
 */
export function moduleWorkflowProviders(sites) {
  const providers = [];
  for (const site of sites ?? []) {
    const modules = site.serverTools?.modules;
    if (!modules?.namespace || !modules.workflows || typeof modules.workflows !== "object") continue;
    const workflows = [];
    for (const [id, body] of Object.entries(modules.workflows)) {
      if (id.startsWith("_") || !body || typeof body !== "object") continue;
      workflows.push({ ...body, id: body.id ?? id });
    }
    providers.push({
      id: `config:${modules.namespace}`,
      namespace: modules.namespace,
      workflows,
    });
  }
  return providers;
}

const INDEX = new Map();
const MODULE_KEYS = new Set();

/**
 * Register built-in workflows for principal filtering.
 *
 * @param {object[]} workflows
 */
export function registerBuiltinWorkflows(workflows) {
  for (const wf of workflows ?? []) INDEX.set(wf.name, wf);
}

/**
 * Replace the module-owned slice of the workflow index (per request).
 *
 * @param {object[]} workflows
 */
export function replaceModuleWorkflows(workflows) {
  for (const key of MODULE_KEYS) INDEX.delete(key);
  MODULE_KEYS.clear();
  for (const wf of workflows ?? []) {
    INDEX.set(wf.name, wf);
    MODULE_KEYS.add(wf.name);
  }
}

/**
 * @param {string} name
 * @returns {object|undefined}
 */
export function lookupWorkflow(name) {
  return INDEX.get(name);
}

/**
 * Index used by tests.
 *
 * @param {object[]} workflows
 * @returns {Map<string, {readOnly: boolean, builtin: boolean, publicTools: string[]}>}
 */
export function workflowIndex(workflows) {
  return new Map((workflows ?? []).map((wf) => [wf.name, {
    readOnly: wf.readOnly,
    builtin: wf.builtin,
    publicTools: wf.publicTools,
  }]));
}

export const WORKFLOW_LIMITS = {
  MAX_DESCRIPTION,
  MAX_INSTRUCTIONS,
  MAX_WORKFLOWS,
};

// Re-export for callers that already import tool prompt hyphenation.
export { toolNameToPromptName };
