#!/usr/bin/env node
/**
 * Source-mutant runner (DEV-866 increment 3).
 *
 *   npm run eval:mutants
 *
 * Copies `src/` to a scratch tree, applies one declared mutation, and runs
 * the eval pack against that copy (`EVAL_HTTP_SRC`). Each mutant must be
 * killed by its pinned case for the pinned reason. A survivor, or a kill
 * on a different assertion, fails the run.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applySourceMutant, SOURCE_MUTANTS } from "./harness/mutations.js";
import { labelMatches } from "./harness/pinned-label.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../../..");
const SRC = join(REPO, "src");
const RUN_PACK = join(HERE, "run-pack.js");
const REPORT_PATH = resolve(process.env.EVAL_MUTANTS_REPORT || "evals-mutants-report.json");
// Scratch copies stay under the repo so Node still resolves `jose` / ESM
// from the workspace package.json (`/tmp/...` cannot see node_modules).

function cleanEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(DRUPAL_|MCP_|TLS_)/.test(key) || /ISSUER|JWKS/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

const log = (line) => process.stdout.write(`${line}\n`);

/**
 * @param {object} report
 * @param {{case: string, reason: string}} killedBy
 * @returns {{result: string, reason?: string}}
 */
export function judgeMutantKill(report, killedBy) {
  const records = Array.isArray(report?.records) ? report.records : [];
  const green = records.find((row) => row.caseId === killedBy.case && row.mutant === "none");
  if (!green) return { result: "missing", reason: `${killedBy.case}: no green-run record` };
  if (green.result === "pass" || green.result === "expected-red") {
    return { result: "survived", reason: green.reason };
  }
  if (green.result === "fail" && labelMatches(green.reason, killedBy.reason)) {
    return { result: "killed", reason: green.reason };
  }
  return {
    result: "killed-wrong-label",
    reason: green.reason,
    expectedLabel: killedBy.reason,
  };
}

function runOne(mutant) {
  const scratch = mkdtempSync(join(REPO, `.eval-mutant-${mutant.id}-`));
  const reportPath = join(scratch, "report.json");
  try {
    cpSync(SRC, scratch, { recursive: true });
    applySourceMutant(scratch, mutant);
    const child = spawnSync(process.execPath, [RUN_PACK], {
      cwd: REPO,
      stdio: "inherit",
      env: cleanEnv({
        EVAL_HTTP_SRC: scratch,
        EVAL_HTTP_REPORT: reportPath,
      }),
    });
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : { records: [] };
    const verdict = judgeMutantKill(report, mutant.killedBy);
    return { id: mutant.id, status: child.status, verdict, report };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const violations = [];
  if (SOURCE_MUTANTS.length === 0) violations.push("no source mutants declared");

  const rows = SOURCE_MUTANTS.map((mutant) => {
    log(`\n=== mutant ${mutant.id}: ${mutant.title} ===`);
    log(`    pinned ${mutant.killedBy.case} / ${mutant.killedBy.reason}`);
    const { verdict } = runOne(mutant);
    if (verdict.result === "survived") {
      violations.push(`${mutant.id}: SURVIVED (pinned case ${mutant.killedBy.case} stayed green)`);
    } else if (verdict.result === "killed-wrong-label") {
      violations.push(
        `${mutant.id}: killed by "${verdict.reason}" (expected "${mutant.killedBy.reason}")`,
      );
    } else if (verdict.result !== "killed") {
      violations.push(`${mutant.id}: ${verdict.result} (${verdict.reason ?? "no reason"})`);
    }
    return {
      id: mutant.id,
      title: mutant.title,
      killedBy: mutant.killedBy,
      result: verdict.result,
      reason: verdict.reason ?? null,
    };
  });

  const ok = violations.length === 0;
  writeFileSync(REPORT_PATH, `${JSON.stringify({ ok, mutants: rows, violations }, null, 2)}\n`);

  log("\nHTTP transport source mutants (synthetic; stub issuer is NOT Paladin)");
  for (const row of rows) {
    log(`  ${row.id.padEnd(22)} ${row.result.padEnd(20)} ${row.killedBy.case} / ${row.killedBy.reason}`);
  }
  if (!ok) {
    log("\nMUTANTS FAILED:");
    for (const violation of violations) log(`  - ${violation}`);
  } else {
    log("\nMUTANTS OK. Each declared source mutant was killed by its pinned case and label.");
  }
  log(`report: ${REPORT_PATH}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
