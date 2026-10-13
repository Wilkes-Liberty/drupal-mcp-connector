/**
 * Ta5 (DEV-866 increment 2, hole a-5).
 *
 * The set of tools and HTTP route/method shapes the pack covers is pinned
 * to the live connector sources — `allDefinitions` and the transport route
 * tables — not a hand-copied list. Every live name must have a covering
 * case in `coverage.json` that is still in the pack.
 *
 * Mutants (both must be killed on the pinned label):
 *   Ta5-add-orphan — invent a tool that has no assignment.
 *   Ta5-delete-case — drop T16 from the pack so its routes lose their case.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineCase } from "../harness/case.js";
import { expectEqual } from "../harness/assert.js";
import {
  applyCoverageMutant,
  assertLiveCoverage,
  liveRoutes,
  liveTools,
  loadAssignment,
} from "../harness/coverage.js";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"));

defineCase({
  id: "Ta5",
  title: "live tools and routes each have a covering pack case",
  needsHarness: false,
  mutants: [
    { id: "Ta5-add-orphan", expectedLabel: "a-5: tool drupal_eval_orphan_no_case has a covering case" },
    { id: "Ta5-delete-case", expectedLabel: "a-5: covering case T16 is in the pack" },
  ],
  async run(h) {
    const inventory = applyCoverageMutant(h.mutant, {
      tools: liveTools(),
      routes: liveRoutes(),
      packCases: [...manifest.cases],
    });
    assertLiveCoverage(h, inventory, loadAssignment(), expectEqual);
  },
});
