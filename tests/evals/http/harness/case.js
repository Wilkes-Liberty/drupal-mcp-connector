/**
 * Case registration. One case = a `run(h)` function plus its rules:
 *
 *   - Green run: the case must pass, unless its id is in known-red.json, in
 *     which case it must FAIL on an assertion. A listed case that passes
 *     throws (flip detection), so the list cannot rot.
 *   - Mutant run: if the case has a dependency-swap mutant, `run(h)` against
 *     the mutated build must FAIL on an assertion. A mutant that leaves the case
 *     green throws (survived mutant).
 *   - A run that executes zero counted assertions throws.
 *
 * Every run appends one synthetic-only record to EVAL_HTTP_EVIDENCE (a JSONL
 * path set by run-pack.js) for the report and the pack-level rules.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- the evidence path is set by run-pack.js; the known-red path is this file's own sibling */

import { appendFileSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { buildHarness, mutantIds } from "./build.js";

const KNOWN_RED = JSON.parse(readFileSync(new URL("../known-red.json", import.meta.url), "utf8"));
delete KNOWN_RED._comment;

function record(entry) {
  if (process.env.EVAL_HTTP_EVIDENCE) {
    appendFileSync(process.env.EVAL_HTTP_EVIDENCE, `${JSON.stringify(entry)}\n`);
  }
}

/** A failed assertion is a verdict; any other error is a broken harness. */
const isVerdict = (error) => error?.name === "AssertionError";

async function attempt(id, mutant, needsHarness, run) {
  const h = needsHarness
    ? await buildHarness({ mutant })
    : { mutant, assertions: 0, configDigest: "none", close: async () => {} };
  try {
    await run(h);
    return { passed: true, h };
  } catch (error) {
    if (!isVerdict(error)) throw error;
    return { passed: false, h, reason: String(error.message).split("\n")[0] };
  } finally {
    await h.close();
  }
}

/**
 * @param {{id: string, title: string, run: (h: object) => Promise<void>, needsHarness?: boolean}} definition
 */
export function defineCase({ id, title, run, needsHarness = true }) {
  const ticket = KNOWN_RED[id];
  const hasMutant = mutantIds().includes(id);

  describe(`${id} ${title}`, () => {
    it(`${id} green run`, async () => {
      const result = await attempt(id, null, needsHarness, run);
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
        record({ ...base, result: "expected-red", ticket, reason: result.reason });
        return;
      }
      record({ ...base, result: result.passed ? "pass" : "fail", ...(result.passed ? {} : { reason: result.reason }) });
      if (!result.passed) throw new Error(`${id}: green run failed: ${result.reason}`);
    });

    if (hasMutant && !ticket) {
      it(`${id} mutant run`, async () => {
        const result = await attempt(id, id, needsHarness, run);
        const base = { caseId: id, mutant: id, configDigest: result.h.configDigest, assertions: result.h.assertions };
        if (result.passed) {
          record({ ...base, result: "survived" });
          throw new Error(`${id}: mutant ${id} SURVIVED (the case stayed green with its guard removed)`);
        }
        record({ ...base, result: "killed", reason: result.reason });
      });
    }
  });
}
