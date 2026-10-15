/**
 * Vitest config for the staging pack mode (DEV-866 increment 3).
 * Loaded only by `npm run eval:http:staging`. The synthetic pack config
 * does not include these files.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/evals/http/cases/staging/*.eval.js"],
    setupFiles: ["tests/setup-http-audit-sink.js"],
    allowOnly: false,
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
