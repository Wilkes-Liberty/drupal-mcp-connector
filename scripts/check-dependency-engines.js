#!/usr/bin/env node
/**
 * check-dependency-engines.js — every production dependency that declares
 * engines.node must cover this package's engines.node.
 *
 * Background (#544): graphql 17.x dropped Node 20 (`^22 || ^24 || >=26`)
 * while this package still advertises `>=20.0.0`. `npm install` on Node 20
 * then warns EBADENGINE. `semver.intersects` is not enough: those ranges
 * overlap at Node 22+, so a Node 20 gap would slip through. `semver.subset`
 * requires the advertised range to sit inside each dependency's range.
 *
 * Reads package.json + package-lock.json. Packages without engines.node are
 * skipped (npm does not warn for those). Dev dependencies are skipped.
 * Exports for tests; side effects run only when executed directly.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- reads package.json / package-lock.json from the repo root; argv[1] is the invoked-script identity check */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Production lockfile entries whose engines.node does not fully cover `ours`.
 *
 * @param {string} ours This package's engines.node range.
 * @param {object} lock Parsed package-lock.json (lockfileVersion 2/3).
 * @returns {Array<{id: string, version: string, engines: string}>}
 */
export function productionEngineMismatches(ours, lock) {
  const mismatches = [];
  for (const [id, meta] of Object.entries(lock.packages ?? {})) {
    if (id === "" || !id.startsWith("node_modules/")) continue;
    if (meta.dev === true) continue;
    const theirs = meta.engines?.node;
    if (typeof theirs !== "string" || theirs.trim() === "") continue;
    if (!semver.subset(ours, theirs)) {
      mismatches.push({
        id,
        version: meta.version ?? "",
        engines: theirs,
      });
    }
  }
  return mismatches;
}

/**
 * @param {{id: string, version: string, engines: string}} row
 * @returns {string}
 */
export function formatMismatch(row) {
  const name = row.id.replace(/^node_modules\//, "");
  const at = row.version ? `@${row.version}` : "";
  return `${name}${at} engines.node ${row.engines}`;
}

/**
 * @param {string} [root]
 * @returns {{ours: string, mismatches: Array<{id: string, version: string, engines: string}>}}
 */
export function checkDependencyEngines(root = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const ours = pkg.engines?.node;
  if (typeof ours !== "string" || ours.trim() === "") {
    throw new Error("package.json is missing engines.node");
  }
  return { ours, mismatches: productionEngineMismatches(ours, lock) };
}

function main() {
  const { ours, mismatches } = checkDependencyEngines();
  if (mismatches.length) {
    console.error(
      `Production dependency engines.node must cover this package's engines.node (${ours}).`,
    );
    for (const row of mismatches) {
      console.error(`  ${formatMismatch(row)}`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Production dependency engines.node cover ${ours}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
