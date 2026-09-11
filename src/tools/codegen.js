/**
 * Tool group: GraphQL Compose Codegen (TypeScript / Next.js scaffolds).
 *
 * Thin Drush wrappers around `drupal/graphql_compose_codegen`. The generator
 * lives on the Drupal site; this connector does not reimplement it and does
 * not run GraphQL Code Generator against the SDL.
 *
 * All three tools are reads. `drupal_codegen_generate` always passes
 * `--dry-run` and never `--output-dir`, so artefacts come back as text for
 * the agent to write locally. Disk writes stay a local DDEV/script concern.
 *
 * Capability: missing module or unknown Drush command fails loud. If
 * `drushSsh.allowedCommands` is set, the `graphql-compose-codegen:*`
 * subcommand must be on that list (same exact-match rule as other Drush tools).
 */

import { getSiteConfig } from "../lib/config.js";
import { sshDrush } from "./drush.js";
import { SecurityError } from "../lib/security.js";
import { validateMachineName } from "../lib/validate.js";

const INSPECT = "graphql-compose-codegen:inspect";
const DIFF = "graphql-compose-codegen:diff";
const GENERATE = "graphql-compose-codegen:generate";

const GENERATE_TIMEOUT_MS = 60000;

/**
 * Parse an optional list of Drupal machine names (array or comma string).
 *
 * @param {string[]|string|undefined} raw Caller value.
 * @param {string} fieldName Error label.
 * @returns {string[]} Validated names, possibly empty.
 */
function parseMachineNameList(raw, fieldName) {
  if (raw === undefined || raw === null || raw === "") return [];
  const parts = Array.isArray(raw)
    ? raw
    : String(raw).split(",");
  return parts
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => validateMachineName(v, fieldName));
}

/**
 * Whether a Drush failure looks like the codegen module is absent.
 *
 * @param {Error} err Bridge error.
 * @returns {boolean}
 */
function looksLikeMissingCodegen(err) {
  const msg = String(err?.message || err || "");
  return /graphql-compose-codegen|gqcc:|no commands defined in the ["']graphql-compose-codegen|command .* does not exist|could not find command/i.test(msg);
}

/**
 * Run a codegen Drush subcommand and return stdout.
 *
 * @param {object} args Tool args.
 * @param {string} [args.site] Site name.
 * @param {string[]|string} [args.bundles] Bundle ids.
 * @param {string[]|string} [args.skipFields] Extra field names to exclude.
 * @param {string} subcommand Drush subcommand (first arg).
 * @param {string[]} extra Extra flags (e.g. --dry-run).
 * @param {number} timeoutMs SSH timeout.
 * @returns {Promise<{output: string, command: string, wroteFiles: false}>}
 */
async function runGqcc(
  { site: siteName, bundles, skipFields },
  subcommand,
  extra = [],
  timeoutMs = 30000,
) {
  const site = getSiteConfig(siteName);
  const names = parseMachineNameList(bundles, "bundles");
  const skip = parseMachineNameList(skipFields, "skipFields");
  const args = [subcommand];
  if (names.length) args.push(`--bundles=${names.join(",")}`);
  if (skip.length) args.push(`--skip-fields=${skip.join(",")}`);
  args.push(...extra);
  try {
    const output = await sshDrush(site, args, timeoutMs);
    return { output, command: args.join(" "), wroteFiles: false };
  } catch (err) {
    if (err instanceof SecurityError) throw err;
    if (looksLikeMissingCodegen(err)) {
      throw new Error(
        "graphql_compose_codegen is not available on this site " +
        `(Drush command "${subcommand}" failed). Install and enable ` +
        "drupal/graphql_compose_codegen, and if drushSsh.allowedCommands is " +
        `set, add "${subcommand}" to that list. ${err.message}`,
      );
    }
    throw err;
  }
}

async function inspect(args) {
  return runGqcc(args, INSPECT);
}

async function diff(args) {
  return runGqcc(args, DIFF);
}

async function generate(args) {
  return runGqcc(args, GENERATE, ["--dry-run"], GENERATE_TIMEOUT_MS);
}

const LIST_PROPS = {
  site: { type: "string" },
  bundles: {
    type: "array",
    items: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
    description: "Node/paragraph bundle ids. Omit for every bundle graphql_compose exposes.",
  },
  skipFields: {
    type: "array",
    items: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
    description: "Extra field machine names to exclude from the scaffold.",
  },
};

export const definitions = [
  {
    name: "drupal_codegen_inspect",
    description:
      "List node and paragraph bundles and extra fields from graphql_compose_codegen (`drush graphql-compose-codegen:inspect`). Requires the module and drushSsh. Missing command fails loud. If allowedCommands is set, include graphql-compose-codegen:inspect. Does not write files.",
    inputSchema: { type: "object", properties: LIST_PROPS },
  },
  {
    name: "drupal_codegen_diff",
    description:
      "Compare the live graphql_compose schema to the last gqcc:generate snapshot (`drush graphql-compose-codegen:diff`). Requires the module and drushSsh. Missing command fails loud. If allowedCommands is set, include graphql-compose-codegen:diff.",
    inputSchema: { type: "object", properties: LIST_PROPS },
  },
  {
    name: "drupal_codegen_generate",
    description:
      "Return TypeScript/GraphQL scaffold artefacts from graphql_compose_codegen as text (`drush graphql-compose-codegen:generate --dry-run`). Never writes on the Drupal host (no --output-dir). Copy artefacts locally. Requires the module and drushSsh. Missing command fails loud. If allowedCommands is set, include graphql-compose-codegen:generate.",
    inputSchema: { type: "object", properties: LIST_PROPS },
  },
];

export const handlers = {
  drupal_codegen_inspect: inspect,
  drupal_codegen_diff: diff,
  drupal_codegen_generate: generate,
};
