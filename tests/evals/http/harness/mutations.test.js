import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applySourceMutant, SOURCE_MUTANTS, sourceMutantIds } from "./mutations.js";
import { judgeMutantKill } from "../run-mutants.js";

const SRC = fileURLToPath(new URL("../../../../src/", import.meta.url));

describe("declared source mutants", () => {
  it("covers the five security sites and each find matches once", () => {
    expect(sourceMutantIds()).toEqual([
      "auth-gate-order",
      "origin-allow-all",
      "grant-fall-through",
      "scope-default-read",
      "audit-deny-as-ok",
    ]);
    for (const mutant of SOURCE_MUTANTS) {
      const source = readFileSync(join(SRC, mutant.file), "utf8");
      expect(source.split(mutant.find).length - 1, mutant.id).toBe(1);
      expect(mutant.find, mutant.id).not.toBe(mutant.replace);
      expect(mutant.killedBy.case, mutant.id).toMatch(/^T\d/);
      expect(mutant.killedBy.reason, mutant.id).toMatch(/\S/);
    }
  });

  it("applySourceMutant rewrites the scratch copy only", () => {
    const scratch = mkdtempSync(join(tmpdir(), "eval-mutant-apply-"));
    try {
      cpSync(SRC, scratch, { recursive: true });
      const mutant = SOURCE_MUTANTS[0];
      applySourceMutant(scratch, mutant);
      expect(readFileSync(join(scratch, mutant.file), "utf8")).toContain(mutant.replace);
      expect(readFileSync(join(SRC, mutant.file), "utf8")).toContain(mutant.find);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("judgeMutantKill requires the pinned case and label, not any red", () => {
    const report = {
      records: [
        { caseId: "T1", mutant: "none", result: "fail", reason: "POST initialize: handler was not reached: expected 0 to be 1" },
        { caseId: "T7", mutant: "none", result: "fail", reason: "POST initialize: status" },
      ],
    };
    expect(judgeMutantKill(report, { case: "T1", reason: "POST initialize: handler was not reached" }).result).toBe("killed");
    expect(judgeMutantKill(report, { case: "T1", reason: "POST initialize: status" }).result).toBe("killed-wrong-label");
    expect(judgeMutantKill({
      records: [{ caseId: "T1", mutant: "none", result: "pass" }],
    }, { case: "T1", reason: "POST initialize: handler was not reached" }).result).toBe("survived");
    expect(judgeMutantKill({ records: [] }, { case: "T1", reason: "x" }).result).toBe("missing");
  });
});
