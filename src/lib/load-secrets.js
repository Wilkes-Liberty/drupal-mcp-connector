/**
 * Load connector secrets the same way for every entry point.
 *
 * MCP clients often spawn `node src/index.js` directly. The shell launcher
 * cannot be the only place that applies `config/secrets.map`, or a process
 * that skipped the launcher starts, resolves zero sites, and advertises only
 * diagnostic tools — the 2.6.0/#180 failure on this machine.
 *
 * The default table matches config/config.example.json. A gitignored
 * config/secrets.map replaces that table for a deployment whose env-var
 * names differ. Per-item Keychain misses stay silent (inert break-glass).
 * Zero overlap between the table and the names in config.json is a
 * distinct case — the two files are jointly inert — and the caller should
 * say so. If every named secret is still unset after this step, the caller
 * must refuse to start.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shipped env-var → Keychain-item pairs. Matches config/config.example.json. */
export const DEFAULT_SECRET_PAIRS = Object.freeze([
  ["MCP_CONTENT_PRODUCTION_SECRET", "drupal-mcp-content-production"],
  ["MCP_CONTENT_STAGING_SECRET", "drupal-mcp-content-staging"],
  ["MCP_DEVELOPER_DEVELOPMENT_SECRET", "drupal-mcp-developer-development"],
  ["MCP_ADMIN_BREAKGLASS_SECRET", "drupal-mcp-admin-breakglass"],
]);

/**
 * Parse a secrets.map body. `#` comments and malformed lines are ignored.
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
export function parseSecretMap(text) {
  const pairs = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const varName = line.slice(0, eq).trim();
    const item = line.slice(eq + 1).trim();
    if (varName && item) pairs.push([varName, item]);
  }
  return pairs;
}

/**
 * Collect clientSecretEnv / apiTokenEnv names from a parsed config object.
 * @param {object} cfg
 * @returns {string[]}
 */
export function namedSecretEnvVars(cfg) {
  const names = [];
  const seen = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    for (const [key, val] of Object.entries(value)) {
      if (key.startsWith("_")) continue;
      if ((key === "clientSecretEnv" || key === "apiTokenEnv") && typeof val === "string") {
        const name = val.trim();
        if (name && !seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
        continue;
      }
      walk(val);
    }
  };
  walk(cfg);
  return names;
}

/**
 * Look up one macOS Keychain generic password. Returns "" when missing or
 * when not on Darwin. Never throws. Never logs the value.
 * @param {string} item
 * @returns {string}
 */
export function lookupKeychainItem(item) {
  if (process.platform !== "darwin" || !item) return "";
  try {
    const value = execFileSync("security", ["find-generic-password", "-s", item, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(value).replace(/\n$/, "");
  } catch {
    return "";
  }
}

/**
 * Apply the secret table and report how the active config lines up with env.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {NodeJS.ProcessEnv} [options.env] Mutated when a lookup succeeds.
 * @param {typeof readFileSync} [options.readFile]
 * @param {(item: string) => string} [options.lookup]
 * @returns {{pairs: number, resolved: number, named: string[], unset: string[], tableVars: string[], source: "map"|"default"}}
 */
export function loadLocalSecrets({
  cwd = process.cwd(),
  env = process.env,
  readFile = readFileSync,
  lookup = lookupKeychainItem,
} = {}) {
  let source = "map";
  let pairs;
  try {
    pairs = parseSecretMap(readFile(join(cwd, "config", "secrets.map"), "utf8"));
  } catch {
    pairs = DEFAULT_SECRET_PAIRS;
    source = "default";
  }

  let resolved = 0;
  for (const [varName, item] of pairs) {
    const current = new Map(Object.entries(env)).get(varName);
    if (current) continue;
    const value = lookup(item);
    if (!value) continue;
    Object.defineProperty(env, varName, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    resolved += 1;
  }

  let named = [];
  try {
    named = namedSecretEnvVars(JSON.parse(readFile(join(cwd, "config", "config.json"), "utf8")));
  } catch {
    named = [];
  }

  const envMap = new Map(Object.entries(env));
  const unset = named.filter((name) => !envMap.get(name));
  const tableVars = pairs.map(([varName]) => varName);
  return { pairs: pairs.length, resolved, named, unset, tableVars, source };
}

/**
 * One-line diagnosis when the secret table and config.json share no names.
 * Null when there is any overlap, or when config names no secrets.
 * Per-item Keychain misses are not a mismatch.
 * @param {{named: string[], tableVars?: string[], source?: "map"|"default"}} loaded
 * @returns {string|null}
 */
export function secretTableMismatchMessage(loaded) {
  if (!loaded.named.length) return null;
  const table = new Set(loaded.tableVars || []);
  const unmapped = loaded.named.filter((name) => !table.has(name));
  if (unmapped.length !== loaded.named.length) return null;
  const source = loaded.source === "map"
    ? "config/secrets.map does not name them"
    : "using shipped defaults; config/secrets.map is absent";
  const unset = Array.isArray(loaded.unset) ? loaded.unset : [];
  const closer = unset.length
    ? "Unset: " + unset.join(", ") + ". Those sites will fail closed."
    : "Named secrets already in the environment stay set; the table will not populate any of them.";
  return (
    "no secret-table entries match clientSecretEnv/apiTokenEnv names in config.json " +
    "(" + unmapped.join(", ") + "); " + source + ". " +
    closer
  );
}

/**
 * Refuse to boot a server that can only advertise diagnostic tools.
 * @param {{named: string[], unset: string[], tableVars?: string[], source?: "map"|"default"}} loaded
 * @returns {string|null} Fatal message, or null when start is allowed.
 */
export function secretLoadFatalMessage(loaded) {
  if (!loaded.named.length || loaded.unset.length !== loaded.named.length) return null;
  const mismatch = secretTableMismatchMessage(loaded);
  if (mismatch) {
    return mismatch + " Refusing to start. Map those names in config/secrets.map (ENV_VAR=keychain-item) or export them before launch.";
  }
  return (
    `every clientSecretEnv/apiTokenEnv named in config.json is unset (${loaded.unset.join(", ")}). ` +
    "Refusing to start. Map those names in config/secrets.map (ENV_VAR=keychain-item) " +
    "or export them before launch."
  );
}
