/**
 * Case registration. One case = a `run(h)` function plus its rules:
 *
 *   - Green run: the case must pass, unless its id is in known-red.json, in
 *     which case it must FAIL on an assertion. A listed case that passes
 *     throws (flip detection), so the list cannot rot. The failing assertion
 *     label must match the pinned `reason` (c-1).
 *   - Mutant run: each declared mutant must FAIL on the pinned assertion
 *     label (a-2). A mutant that stays green, or is killed by a different
 *     label, throws.
 *   - A run that executes zero counted assertions throws.
 *
 * Every run appends one synthetic-only record to EVAL_HTTP_EVIDENCE (a JSONL
 * path set by run-pack.js) for the report and the pack-level rules.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { buildHarness } from "./build.js";
import { assertionLabel, labelMatches } from "./pinned-label.js";

const KNOWN_RED = JSON.parse(readFileSync(new URL("../known-red.json", import.meta.url), "utf8"));
delete KNOWN_RED._comment;
delete KNOWN_RED._schema;

/**
 * @param {unknown} value
 * @returns {{ticket?: string, expires?: string, reason?: string}|null}
 */
export function knownRedEntry(value) {
  if (!value) return null;
  if (typeof value === "string") return { ticket: value };
  if (typeof value === "object") return value;
  return null;
}

function record(entry) {
  if (process.env.EVAL_HTTP_EVIDENCE) {
    appendFileSync(process.env.EVAL_HTTP_EVIDENCE, `${JSON.stringify(entry)}\n`);
  }
}

/** A failed assertion is a verdict; any other error is a broken harness. */
const isVerdict = (error) => error?.name === "AssertionError";

async function attempt(id, mutant, needsHarness, run, harness = {}) {
  const h = needsHarness
    ? await buildHarness({ ...harness, mutant })
    : { mutant, assertions: 0, configDigest: "none", auditRows: [], close: async () => {} };
  try {
    await run(h);
    return { passed: true, h };
  } catch (error) {
    if (!isVerdict(error)) throw error;
    return { passed: false, h, reason: assertionLabel(error.message) };
  } finally {
    await h.close();
  }
}

/**
 * @param {{
 *   id: string,
 *   title: string,
 *   run: (h: object) => Promise<void>,
 *   needsHarness?: boolean,
 *   harness?: object,
 *   mutants?: Array<{id: string, expectedLabel: string}>,
 * }} definition
 */
export function defineCase({
  id,
  title,
  run,
  needsHarness = true,
  harness = {},
  mutants = [],
} = {}) {
  const ticketEntry = knownRedEntry(KNOWN_RED[id]);
  const ticket = ticketEntry?.ticket;

  describe(`${id} ${title}`, () => {
    it(`${id} green run`, async () => {
      const result = await attempt(id, null, needsHarness, run, harness);
      const base = { caseId: id, mutant: "none", configDigest: result.h.configDigest, assertions: result.h.assertions };
      if (result.h.assertions === 0) {
        record({ ...base, result: "no-assertions" });
        throw new Error(`${id}: the green run executed zero counted assertions`);
      }
      if (ticket) {
        if (result.passed) {
          record({ ...base, result: "flipped", ticket });
          throw new Error(`${id}: listed as known-red (${ticket}) but PASSED. Remove it from known-red.json.`);
        }
        if (ticketEntry.reason && !labelMatches(result.reason, ticketEntry.reason)) {
          record({ ...base, result: "wrong-red-reason", ticket, reason: result.reason });
          throw new Error(
            `${id}: known-red failed on "${result.reason}" but known-red.json pins "${ticketEntry.reason}"`,
          );
        }
        record({ ...base, result: "expected-red", ticket, reason: result.reason });
        return;
      }
      record({ ...base, result: result.passed ? "pass" : "fail", ...(result.passed ? {} : { reason: result.reason }) });
      if (!result.passed) throw new Error(`${id}: green run failed: ${result.reason}`);
    });

    if (!ticket) {
      for (const mutant of mutants) {
        it(`${id} mutant ${mutant.id}`, async () => {
          if (!mutant.expectedLabel) {
            throw new Error(`${id}: mutant ${mutant.id} is missing expectedLabel (a-2)`);
          }
          const result = await attempt(id, mutant.id, needsHarness, run, harness);
          const base = {
            caseId: id,
            mutant: mutant.id,
            configDigest: result.h.configDigest,
            assertions: result.h.assertions,
          };
          if (result.passed) {
            record({ ...base, result: "survived" });
            throw new Error(`${id}: mutant ${mutant.id} SURVIVED (the case stayed green with its guard removed)`);
          }
          if (!labelMatches(result.reason, mutant.expectedLabel)) {
            record({ ...base, result: "killed-wrong-label", reason: result.reason, expectedLabel: mutant.expectedLabel });
            throw new Error(
              `${id}: mutant ${mutant.id} was killed by "${result.reason}" but expected label "${mutant.expectedLabel}"`,
            );
          }
          record({ ...base, result: "killed", reason: result.reason, expectedLabel: mutant.expectedLabel });
        });
      }
    }
  });
}
