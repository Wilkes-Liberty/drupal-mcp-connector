#!/usr/bin/env node
/**
 * Operator install wizard (DEV-758).
 *
 *   npx drupal-mcp-connector init
 *   npx drupal-mcp-connector wizard
 *   node bin/drupal-mcp-wizard.js --yes
 */

import { runWizardCli } from "../src/lib/wizard.js";

runWizardCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`wizard: ${err?.message ?? err}\n`);
    process.exit(2);
  });
