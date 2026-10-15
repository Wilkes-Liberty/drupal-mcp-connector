/**
 * Declared source mutants for `npm run eval:mutants` (DEV-866 increment 3).
 *
 * Each entry patches one security-relevant site in a scratch copy of `src/`.
 * The runner then executes the eval pack against that copy and requires the
 * pinned case to fail on the pinned assertion label — not merely "any red".
 * A survivor, or a kill on the wrong label, fails the run.
 *
 * Patches live here, in `tests/`. Production `src/` has no mutant switch.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   file: string,
 *   find: string,
 *   replace: string,
 *   killedBy: { case: string, reason: string },
 * }} SourceMutant
 */

/** @type {readonly SourceMutant[]} */
export const SOURCE_MUTANTS = Object.freeze([
  {
    id: "auth-gate-order",
    title: "dispatch continues after a failed auth gate",
    file: "lib/http-handler.js",
    find: "    if (!await gateAuth(req, res)) {\n      noteFailedAuthAddress(req, res);\n      return;\n    }",
    replace: "    if (!await gateAuth(req, res)) {\n      noteFailedAuthAddress(req, res);\n    }",
    killedBy: { case: "T1", reason: "POST initialize: handler was not reached" },
  },
  {
    id: "origin-allow-all",
    title: "Origin check always allows",
    file: "lib/http-transport.js",
    find: "export function originAllowed(originHeader, allowlist) {\n  if (originHeader === undefined || originHeader === null || originHeader === \"\") {\n    return true;\n  }",
    replace: "export function originAllowed(originHeader, allowlist) {\n  return true;\n  if (originHeader === undefined || originHeader === null || originHeader === \"\") {\n    return true;\n  }",
    killedBy: { case: "T11", reason: "disallowed Origin: status" },
  },
  {
    id: "grant-fall-through",
    title: "no grant table and no sites claim entitles every configured site",
    file: "lib/principal.js",
    find: "  if (Array.isArray(identity.sites)) {\n    return identity.sites.map(String).filter((name) => known.has(name));\n  }\n\n  return [];\n}",
    replace: "  if (Array.isArray(identity.sites)) {\n    return identity.sites.map(String).filter((name) => known.has(name));\n  }\n\n  return [...configuredNames];\n}",
    killedBy: { case: "T4b", reason: "tools/list is empty without a grant or sites claim" },
  },
  {
    id: "scope-default-read",
    title: "a tool with no scope-table row is treated as mcp_read",
    file: "lib/tool-scopes.js",
    find: "  const entry = toolScopeEntry(toolName);\n  if (!entry) return `${MISSING_SCOPE_ENTRY_REASON} (${toolName}).`;",
    replace: "  const entry = toolScopeEntry(toolName);\n  if (!entry) return null;",
    killedBy: { case: "T17", reason: "unscoped tool absent from tools/list" },
  },
  {
    id: "audit-deny-as-ok",
    title: "a 401 is classified as an audit ok",
    file: "lib/http-audit.js",
    find: "  if (code === 401) return hasAuthorization ? \"invalid_token\" : \"unauthenticated\";",
    replace: "  if (code === 401) return \"ok\";",
    killedBy: { case: "T8", reason: "missing-token 401: code" },
  },
]);

/**
 * Apply one declared mutant to a scratch copy of `src/`.
 *
 * @param {string} srcRoot
 * @param {SourceMutant} mutant
 */
export function applySourceMutant(srcRoot, mutant) {
  const path = join(srcRoot, mutant.file);
  const source = readFileSync(path, "utf8");
  const matches = source.split(mutant.find).length - 1;
  if (matches !== 1) {
    throw new Error(`${mutant.id}: find must match exactly once in ${mutant.file} (matched ${matches})`);
  }
  writeFileSync(path, source.replace(mutant.find, mutant.replace));
}

/** @returns {string[]} */
export const sourceMutantIds = () => SOURCE_MUTANTS.map((mutant) => mutant.id);
