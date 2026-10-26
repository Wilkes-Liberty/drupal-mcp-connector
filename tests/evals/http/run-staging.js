#!/usr/bin/env node
/**
 * Staging pack mode (DEV-866 increment 3).
 *
 *   npm run eval:http:staging
 *
 * Same deny / allow twins as the synthetic pack, aimed at a real staging
 * endpoint. Read-only. No secrets in the repo. When the base URL and
 * issuer are unset the process exits 0 with a skip reason.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missingStagingTokens, readStagingConfig, STAGING_SKIP_REASON } from "./harness/staging.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../../..");
const REPORT_PATH = resolve(process.env.EVAL_HTTP_STAGING_REPORT || "evals-http-staging-report.json");
const STAGING_CASES = ["T1", "T2a", "T2e", "T2s", "T2m", "T11", "T7"];

function cleanEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("EVAL_HTTP_STAGING_")) {
      env[key] = value;
      continue;
    }
    if (/^(DRUPAL_|MCP_|TLS_)/.test(key) || /ISSUER|JWKS/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

const log = (line) => process.stdout.write(`${line}\n`);

function main() {
  const config = readStagingConfig();
  if (!config) {
    log(STAGING_SKIP_REASON);
    writeFileSync(REPORT_PATH, `${JSON.stringify({
      ok: true,
      skipped: true,
      reason: STAGING_SKIP_REASON,
      cases: [],
    }, null, 2)}\n`);
    process.exit(0);
  }

  const missing = missingStagingTokens(config);
  const violations = [];
  if (missing.length) {
    violations.push(`staging configured but missing ${missing.join(", ")}`);
  }

  const work = mkdtempSync(join(tmpdir(), "eval-http-staging-"));
  const evidencePath = join(work, "evidence.jsonl");
  const jsonPath = join(work, "vitest.json");
  writeFileSync(evidencePath, "");

  const vitest = join(REPO, "node_modules", "vitest", "vitest.mjs");
  const child = spawnSync(process.execPath, [
    vitest, "run",
    "--config", join(REPO, "tests/evals/vitest.staging.config.js"),
    "--reporter=default", "--reporter=json", `--outputFile.json=${jsonPath}`,
  ], {
    cwd: REPO,
    stdio: "inherit",
    // Staging vs synthetic is the vitest config, not an env flag.
    env: cleanEnv({ EVAL_HTTP_EVIDENCE: evidencePath }),
  });
  if (child.status !== 0) violations.push(`vitest exited with status ${child.status}`);

  const vitestJson = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")) : { testResults: [] };
  const tests = (vitestJson.testResults || []).flatMap((file) => file.assertionResults || []);
  if (tests.length === 0 && missing.length === 0) violations.push("zero staging cases ran");
  for (const test of tests) {
    if (test.status !== "passed") violations.push(`${test.fullName}: status ${test.status}`);
  }
  const discovered = [...new Set(tests.map((test) => /^(\S+) /.exec(test.title)?.[1]).filter(Boolean))].sort();
  if (missing.length === 0 && JSON.stringify(discovered) !== JSON.stringify([...STAGING_CASES].sort())) {
    violations.push(`discovered staging cases [${discovered}] differ from [${[...STAGING_CASES].sort()}]`);
  }

  const records = existsSync(evidencePath)
    ? readFileSync(evidencePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  rmSync(work, { recursive: true, force: true });
  for (const record of records) {
    if (!(record.assertions > 0)) violations.push(`${record.caseId}: zero counted assertions`);
    if (record.result === "fail") violations.push(`${record.caseId}: failed (${record.reason})`);
  }

  const ok = violations.length === 0;
  writeFileSync(REPORT_PATH, `${JSON.stringify({
    ok,
    skipped: false,
    issuer: config.issuer,
    cases: STAGING_CASES,
    records,
    violations,
  }, null, 2)}\n`);

  log("\nHTTP transport staging pack (read-only; Paladin/Sentinel, not the stub issuer)");
  for (const id of STAGING_CASES) {
    const row = records.find((record) => record.caseId === id);
    log(`  ${id.padEnd(4)} ${row?.result ?? "missing"}`);
  }
  if (!ok) {
    log("\nSTAGING PACK FAILED:");
    for (const violation of violations) log(`  - ${violation}`);
  } else {
    log("\nSTAGING PACK OK. Read-only observation of the configured endpoint; not a write.");
  }
  log(`report: ${REPORT_PATH}`);
  process.exit(ok ? 0 : 1);
}

main();
