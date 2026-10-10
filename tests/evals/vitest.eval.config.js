/**
 * Vitest config for the HTTP transport eval pack (DEV-866). Separate from the
 * default `vitest run`, which matches only *.test.js and so never picks up the
 * *.eval.js cases. Run it with `npm run eval:http`.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/evals/http/cases/*.eval.js"],
    allowOnly: false,
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
