#!/usr/bin/env node
/**
 * Run the HTTP transport eval pack and enforce the pack rules.
 *
 *   npm run eval:http
 *
 * Rules (vault note "Hosted MCP connector — HTTP transport evals, guardrails,
 * and CI harness (2026-10-10)", section 6, plus increment-2 review holes):
 *   1. An empty or skipped pack fails: discovered case ids must equal
 *      manifest.json; no case may be skipped, todo, or only; at least one case
 *      must run; every run must execute at least one counted assertion.
 *   2. A survived mutant fails. A mutant killed by the wrong assertion label
 *      fails (a-2).
 *   3. Known-red is strict: a listed case must fail on the green run, and a
 *      listed case that passes fails the pack. Each entry needs a ticket,
 *      expiry date, and pinned reason (c-1, c-2).
 *   5. No ambient credentials: DRUPAL_*, MCP_*, TLS_*, and issuer variables are
 *      cleared from the child environment. Keys are generated in memory.
 *   a-5. Request-label and route sets are pinned to the manifest.
 * Rule 4 (scanner self-test first) arrives with X1s in increment 4.
 * Also (R-A7): src/ must not mention the harness's own switches.
 *
 * Writes evals-http-report.json (override the path with EVAL_HTTP_REPORT).
 * Only synthetic data enters it.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path comes from this file's location, a temp dir, or the operator-set report path */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EDGE_NORTHBOUND_AUX_ROUTES } from "../../../src/lib/relay/edge.js";
import {
  MCP_HTTP_METHODS,
  MCP_HTTP_PATH,
  UNAUTHENTICATED_ROUTES,
} from "../../../src/lib/http-handler.js";
import { EVAL_TOOL_NAMES, UNAUTHENTICATED_LABELS } from "./harness/labels.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../../..");
const SRC_DIR = process.env.EVAL_HTTP_SRC ? resolve(process.env.EVAL_HTTP_SRC) : join(REPO, "src");
const REPORT_PATH = resolve(process.env.EVAL_HTTP_REPORT || "evals-http-report.json");
const SWITCH_PATTERN = /EVAL_HTTP_|eval:http|tests\/evals\//;
const TICKET = /^DEV-\d+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const readJson = (name) => JSON.parse(readFileSync(join(HERE, name), "utf8"));

function filesUnder(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** R-A7: no production code path reads an eval or mutant switch. */
function seamViolations() {
  return filesUnder(SRC_DIR)
    .filter((file) => file.endsWith(".js") && SWITCH_PATTERN.test(readFileSync(file, "utf8")))
    .map((file) => `R-A7: ${file} mentions an eval harness switch`);
}

function cleanEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(DRUPAL_|MCP_|TLS_)/.test(key) || /ISSUER|JWKS/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

const log = (line) => process.stdout.write(`${line}\n`);

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeKnownRed(raw) {
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (id.startsWith("_")) continue;
    out[id] = typeof value === "string" ? { ticket: value } : value;
  }
  return out;
}

function srcRouteList() {
  return [
    ...UNAUTHENTICATED_ROUTES.map((route) => `${route.method} ${route.path}`),
    ...MCP_HTTP_METHODS.map((method) => `${method} ${MCP_HTTP_PATH}`),
    ...EDGE_NORTHBOUND_AUX_ROUTES.map((route) => `${route.method} ${route.path}`),
  ].sort();
}

function main() {
  const manifestFile = readJson("manifest.json");
  const manifest = manifestFile.cases;
  const knownRed = normalizeKnownRed(readJson("known-red.json"));
  const violations = [...seamViolations()];

  if (!Array.isArray(manifest) || manifest.length === 0) violations.push("manifest.json lists no cases");

  const indexJs = readFileSync(join(SRC_DIR, "index.js"), "utf8");
  if (!indexJs.includes("startHttpsTransport")) {
    violations.push("a-4: src/index.js does not call startHttpsTransport (eval must drive real startup wiring)");
  }

  const pinnedRoutes = (manifestFile.routes || []).map((route) => `${route.method} ${route.path}`).sort();
  const discoveredRoutes = srcRouteList();
  if (JSON.stringify(pinnedRoutes) !== JSON.stringify(discoveredRoutes)) {
    violations.push(
      `a-5: manifest.routes [${pinnedRoutes}] differ from src routes [${discoveredRoutes}]`,
    );
  }

  const pinnedLabels = [...(manifestFile.requestLabels || [])].sort();
  const expectedLabels = [...UNAUTHENTICATED_LABELS].sort();
  if (JSON.stringify(pinnedLabels) !== JSON.stringify(expectedLabels)) {
    violations.push(
      `a-5: manifest.requestLabels [${pinnedLabels}] differ from UNAUTHENTICATED_LABELS [${expectedLabels}]`,
    );
  }

  const pinnedTools = [...(manifestFile.tools || [])].sort();
  if (JSON.stringify(pinnedTools) !== JSON.stringify([...EVAL_TOOL_NAMES].sort())) {
    violations.push(
      `a-5: manifest.tools [${pinnedTools}] differ from EVAL_TOOL_NAMES [${[...EVAL_TOOL_NAMES]}]`,
    );
  }

  const today = todayUtc();
  for (const [id, entry] of Object.entries(knownRed)) {
    if (!manifest.includes(id)) violations.push(`known-red.json lists ${id}, which is not in manifest.json`);
    if (!entry || typeof entry !== "object") {
      violations.push(`known-red.json: ${id} must be { ticket, expires, reason }`);
      continue;
    }
    if (!TICKET.test(entry.ticket || "")) {
      violations.push(`known-red.json: ${id} needs an open ticket key, got "${entry.ticket ?? ""}"`);
    }
    if (!DAY.test(entry.expires || "")) {
      violations.push(`known-red.json: ${id} needs an expiry date (YYYY-MM-DD)`);
    } else if (entry.expires < today) {
      violations.push(`known-red.json: ${id} expired on ${entry.expires} (today ${today})`);
    }
    if (!entry.reason || typeof entry.reason !== "string") {
      violations.push(`known-red.json: ${id} needs the pinned failing assertion label (c-1)`);
    }
  }

  const work = mkdtempSync(join(tmpdir(), "eval-http-"));
  const evidencePath = join(work, "evidence.jsonl");
  const jsonPath = join(work, "vitest.json");
  writeFileSync(evidencePath, "");

  const vitest = join(REPO, "node_modules", "vitest", "vitest.mjs");
  const child = spawnSync(process.execPath, [
    vitest, "run",
    "--config", join(REPO, "tests/evals/vitest.eval.config.js"),
    "--reporter=default", "--reporter=json", `--outputFile.json=${jsonPath}`,
  ], {
    cwd: REPO,
    stdio: "inherit",
    env: cleanEnv({ EVAL_HTTP_EVIDENCE: evidencePath }),
  });
  if (child.status !== 0) violations.push(`vitest exited with status ${child.status}`);

  const vitestJson = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")) : { testResults: [] };
  const tests = vitestJson.testResults.flatMap((file) => file.assertionResults);
  if (tests.length === 0) violations.push("zero cases ran");
  for (const test of tests) {
    if (test.status !== "passed") violations.push(`${test.fullName}: status ${test.status}`);
  }
  const discovered = [...new Set(tests.map((test) => /^(\S+) /.exec(test.title)?.[1]).filter(Boolean))].sort();
  if (JSON.stringify(discovered) !== JSON.stringify([...manifest].sort())) {
    violations.push(`discovered cases [${discovered}] differ from manifest [${[...manifest].sort()}]`);
  }

  const records = readFileSync(evidencePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  rmSync(work, { recursive: true, force: true });
  for (const record of records) {
    if (!(record.assertions > 0)) violations.push(`${record.caseId} (${record.mutant}): zero counted assertions`);
    if (record.result === "survived") violations.push(`${record.caseId}: mutant ${record.mutant} survived`);
    if (record.result === "killed-wrong-label") {
      violations.push(
        `${record.caseId}: mutant ${record.mutant} killed by "${record.reason}" (expected "${record.expectedLabel}")`,
      );
    }
    if (record.result === "flipped") violations.push(`${record.caseId}: known-red case passed (flip); remove it from known-red.json`);
    if (record.result === "fail") violations.push(`${record.caseId}: green run failed (${record.reason})`);
    if (record.result === "wrong-red-reason") {
      violations.push(`${record.caseId}: known-red failed on the wrong assertion (${record.reason})`);
    }
  }

  const rows = manifest.map((id) => {
    const green = records.find((r) => r.caseId === id && r.mutant === "none");
    const mutantRecords = records.filter((r) => r.caseId === id && r.mutant !== "none");
    if (!green) violations.push(`${id}: no green-run record`);
    if (knownRed[id]) {
      if (green && green.result !== "expected-red") violations.push(`${id}: listed known-red but result was ${green.result}`);
      if (mutantRecords.length) violations.push(`${id}: known-red cases carry no mutant in this increment`);
    } else {
      if (green && green.result !== "pass") violations.push(`${id}: green run result ${green.result}`);
      if (!mutantRecords.length) violations.push(`${id}: no mutant record (every non-known-red case needs a killed mutant)`);
      for (const mutant of mutantRecords) {
        if (mutant.result !== "killed") violations.push(`${id}: mutant ${mutant.mutant} result ${mutant.result}`);
      }
    }
    return {
      case: id,
      green: green?.result ?? "missing",
      ticket: knownRed[id]?.ticket ?? null,
      mutants: mutantRecords.map((mutant) => ({
        id: mutant.mutant,
        result: mutant.result,
        reason: mutant.reason ?? null,
      })),
      configDigest: green?.configDigest ?? null,
      assertions: {
        green: green?.assertions ?? 0,
        mutant: mutantRecords.reduce((sum, mutant) => sum + (mutant.assertions ?? 0), 0),
      },
    };
  });

  const ok = violations.length === 0;
  writeFileSync(REPORT_PATH, `${JSON.stringify({ ok, source: SRC_DIR === join(REPO, "src") ? "src" : "scratch", cases: rows, records, violations }, null, 2)}\n`);

  log("\nHTTP transport eval pack (synthetic; stub issuer is NOT Paladin)");
  for (const row of rows) {
    const green = row.green === "expected-red" ? `expected-red (${row.ticket})` : row.green;
    const mutant = row.mutants.length
      ? row.mutants.map((item) => `${item.id}:${item.result}`).join(", ")
      : "no mutant (known-red)";
    log(`  ${row.case.padEnd(4)} green: ${green.padEnd(22)} ${mutant}`);
  }
  if (!ok) {
    log("\nPACK FAILED:");
    for (const violation of violations) log(`  - ${violation}`);
  } else {
    log("\nPACK OK. Not production proof: this proves connector logic over fakes, not Paladin, Keystone, or production Sentinel.");
  }
  log(`report: ${REPORT_PATH}`);
  process.exit(ok ? 0 : 1);
}

main();
