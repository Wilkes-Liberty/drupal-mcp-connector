#!/usr/bin/env node
/** Browser PKCE sign-in and local connector startup in one process. */
import { loadConfig, getSiteConfig } from "../src/lib/config.js";
import { signInSites } from "../src/lib/pkce-cli.js";

try {
  await signInSites(loadConfig(), getSiteConfig);
  await import("../src/index.js");
} catch {
  console.error("[drupal-mcp-connector] Browser sign-in failed. Check configuration and start a new sign-in session.");
  process.exitCode = 1;
}
