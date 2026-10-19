/**
 * In-process workflow prompt index used by principal filtering.
 *
 * Kept off `workflow-prompts.js` so `principal.js` can look up a prompt
 * without importing module catalog discovery (and cycling through
 * governance → principal → workflows → module-tools → governance).
 */

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
