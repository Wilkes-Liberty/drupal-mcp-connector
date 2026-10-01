#!/usr/bin/env node
/**
 * Connection doctor (DEV-759).
 *
 * npx drupal-mcp-connector doctor
 * node bin/drupal-mcp-doctor.js --json
 */

import { runDoctorCli } from "../src/lib/doctor.js";

runDoctorCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`doctor: ${err?.message ?? err}\n`);
    process.exit(2);
  });
