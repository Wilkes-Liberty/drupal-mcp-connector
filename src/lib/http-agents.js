/**
 * Shared keep-alive HTTP(S) agents for outbound Drupal / MCP calls.
 *
 * Listing walks many sites at once. Reusing sockets keeps a cold tools/list
 * from opening a new TLS session per hop (token, readiness, /mcp).
 */

import http from "node:http";
import https from "node:https";

const AGENT_OPTIONS = Object.freeze({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 60_000,
});

/** Shared HTTP keep-alive agent. */
export const keepAliveHttpAgent = new http.Agent(AGENT_OPTIONS);

/** Shared HTTPS keep-alive agent. */
export const keepAliveHttpsAgent = new https.Agent(AGENT_OPTIONS);

/**
 * Pick the keep-alive agent for a request URL.
 *
 * @param {string} url Absolute URL.
 * @returns {http.Agent|https.Agent}
 */
export function keepAliveAgentFor(url) {
  try {
    return new URL(url).protocol === "http:" ? keepAliveHttpAgent : keepAliveHttpsAgent;
  } catch {
    return keepAliveHttpsAgent;
  }
}
