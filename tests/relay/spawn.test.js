/**
 * Spawn-level denies for the relay entry points (#232).
 *
 * The processes themselves must refuse to exist under unsafe configuration —
 * an operator relies on the exit, not on a unit test of the resolver:
 *
 *   - the edge is fatal without issuer/audience at any bind host, with the
 *     shared-bearer and trusted-proxy environment escape hatches present and
 *     ignored;
 *   - the edge is fatal without a grant table and without a channel
 *     credential store;
 *   - a network-facing edge bind without TLS is fatal;
 *   - the control run passes every one of those gates and dies later, at
 *     issuer discovery against an unresolvable reserved host — proving the
 *     earlier exits were the gates, not incidental breakage;
 *   - the agent is fatal without its issued channel credential.
 *
 * Hostnames are RFC 2606/6761 reserved names only.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const EDGE_BIN = join(repoRoot, "bin", "drupal-mcp-edge.js");
const AGENT_BIN = join(repoRoot, "bin", "drupal-mcp-agent.js");

function spawnBin(bin, { cwd, env = {} } = {}) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [bin], {
      cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ code, stdout, stderr });
    });
  });
}

function tempConfigDir(config) {
  const dir = mkdtempSync(join(tmpdir(), "relay-232-spawn-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "config.json"), JSON.stringify(config));
  return dir;
}

const SITES = { staging: { baseUrl: "https://drupal.example/" } };
const GRANTS = { "client-a": ["staging"] };
const AUTH = {
  issuer: "https://idp.invalid",
  audience: "https://edge.invalid/mcp",
};

function channelFileIn(dir) {
  const filePath = join(dir, "channel-credentials.json");
  writeFileSync(filePath, JSON.stringify({
    agents: { "tenant-a": { tokenSha256: "0".repeat(64) } },
  }));
  return filePath;
}

describe("drupal-mcp-edge spawn-level denies", () => {
  it("dies without issuer/audience even with every legacy escape hatch set", async () => {
    const cwd = tempConfigDir({ defaultSite: "staging", sites: SITES });
    const result = await spawnBin(EDGE_BIN, {
      cwd,
      env: {
        MCP_AUTH_TOKEN: "legacy-shared-secret",
        MCP_ALLOW_UNAUTHENTICATED: "1",
        MCP_ALLOW_HTTP: "1",
        MCP_CHANNEL_CREDENTIALS_FILE: channelFileIn(cwd),
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/issuer/i);
    expect(result.stderr).toMatch(/audience/i);
    expect(result.stdout).not.toMatch(/Listening|northbound/i);
  });

  it("dies without a grant table", async () => {
    const cwd = tempConfigDir({ defaultSite: "staging", sites: SITES, auth: AUTH });
    const result = await spawnBin(EDGE_BIN, {
      cwd,
      env: {
        MCP_ALLOW_HTTP: "1",
        MCP_CHANNEL_CREDENTIALS_FILE: channelFileIn(cwd),
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/grant/i);
  });

  it("dies without a channel credential store", async () => {
    const cwd = tempConfigDir({
      defaultSite: "staging",
      sites: SITES,
      auth: { ...AUTH, grants: GRANTS },
    });
    const result = await spawnBin(EDGE_BIN, { cwd, env: { MCP_ALLOW_HTTP: "1" } });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/channel credential/i);
  });

  it("dies on a network-facing bind without TLS", async () => {
    const cwd = tempConfigDir({
      defaultSite: "staging",
      sites: SITES,
      auth: { ...AUTH, grants: GRANTS },
    });
    const result = await spawnBin(EDGE_BIN, {
      cwd,
      env: {
        MCP_BIND_HOST: "0.0.0.0",
        MCP_CHANNEL_CREDENTIALS_FILE: channelFileIn(cwd),
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/TLS/);
  });

  it("control: passes every gate and dies at issuer discovery instead", async () => {
    const cwd = tempConfigDir({
      defaultSite: "staging",
      sites: SITES,
      auth: { ...AUTH, grants: GRANTS },
    });
    const result = await spawnBin(EDGE_BIN, {
      cwd,
      env: {
        MCP_ALLOW_HTTP: "1",
        MCP_CHANNEL_CREDENTIALS_FILE: channelFileIn(cwd),
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/metadata not found|discovery/i);
    expect(result.stderr).not.toMatch(/grant|channel credential|requires TLS/i);
  });
});

describe("drupal-mcp-agent spawn-level denies", () => {
  it("dies without its issued channel credential", async () => {
    const cwd = tempConfigDir({ defaultSite: "staging", sites: SITES });
    const result = await spawnBin(AGENT_BIN, {
      cwd,
      env: {
        MCP_EDGE_HOST: "127.0.0.1",
        MCP_EDGE_AGENT_PORT: "1",
      },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/channel credential|MCP_CHANNEL_TOKEN/);
  });
});
