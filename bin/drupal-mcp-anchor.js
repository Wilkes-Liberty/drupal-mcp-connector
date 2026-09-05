#!/usr/bin/env node
/**
 * drupal-mcp-anchor — independent Ed25519 notary (#261).
 *
 * Separate process from the relay edge. Holds the private key and never
 * shares it. Prints the public pin the edge must configure in
 * `auth.evidenceAnchor.publicKey`. Loopback only. Not a hosted-service
 * or design-partner admission claim. Audit Chain NDJSON is the off-system
 * stream, not this process.
 *
 * Environment variables:
 *   MCP_ANCHOR_PORT   Listen port (default 0 = ephemeral; printed).
 *   MCP_ANCHOR_BIND   Bind host (default 127.0.0.1). Non-loopback refused.
 */

import process from "node:process";
import { createNotary, startAnchorServer } from "../src/lib/anchor.js";

function fatal(message) {
  console.error(`[drupal-mcp-anchor] FATAL: ${message}`);
  process.exit(1);
}

const bindHost = process.env.MCP_ANCHOR_BIND || "127.0.0.1";
const loopback = bindHost === "127.0.0.1" || bindHost === "::1" || bindHost === "localhost";
if (!loopback) {
  fatal(
    "The notary binds loopback only. Set MCP_ANCHOR_BIND to 127.0.0.1 "
    + "(or omit it). A separately administered production host is not chosen here.",
  );
}

const portRaw = process.env.MCP_ANCHOR_PORT;
const port = portRaw === undefined || portRaw === "" ? 0 : Number(portRaw);
if (!Number.isInteger(port) || port < 0) {
  fatal("MCP_ANCHOR_PORT must be a non-negative integer (0 = ephemeral).");
}

const notary = createNotary();
const server = await startAnchorServer({ notary, bindHost, port });

console.error(
  `[drupal-mcp-anchor] Listening ${server.url} · keyId ${notary.keyId}`,
);
console.error("[drupal-mcp-anchor] Pin this public key on the edge (auth.evidenceAnchor.publicKey):");
console.error(notary.publicPin);

function shutdown() {
  server.close().then(() => process.exit(0), () => process.exit(1));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
