import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CLI smoke + failure modes for the operator wizard (DEV-758).
 * Spawns the real bin / index entry — not a mirror of helper functions.
 */

const wizardBin = fileURLToPath(new URL("../../bin/drupal-mcp-wizard.js", import.meta.url));
const indexBin = fileURLToPath(new URL("../../src/index.js", import.meta.url));

/**
 * @param {string[]} args
 * @param {{cwd?: string, bin?: string, env?: NodeJS.ProcessEnv}} [opts]
 */
function runWizard(args, opts = {}) {
  return spawnSync(process.execPath, [opts.bin || wizardBin, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    timeout: 20_000,
  });
}

describe("drupal-mcp-wizard CLI", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-wizard-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("wizard --help and init --help print usage", () => {
    const wizard = runWizard(["--help"]);
    expect(wizard.status).toBe(0);
    expect(wizard.stdout).toMatch(/wizard\|init/);
    expect(wizard.stdout).toMatch(/--yes/);
    expect(wizard.stdout).toMatch(/Tailscale/);

    const init = runWizard(["init", "--help"], { bin: indexBin });
    expect(init.status).toBe(0);
    expect(init.stdout).toMatch(/--non-interactive/);
  });

  it("non-interactive path emits valid Cursor + Claude mcpServers JSON without Drupal", () => {
    const result = runWizard([
      "--yes",
      "--json",
      "--host", "https://drupal.example.com",
      "--client-id", "content-agent",
      "--output", dir,
    ]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.clients.cursor.config.mcpServers.drupal.command).toBe("npx");
    expect(body.clients.cursor.config.mcpServers.drupal.args).toEqual(["-y", "drupal-mcp-connector"]);
    expect(body.clients.cursor.config.mcpServers.drupal.env.DRUPAL_BASE_URL).toBe("https://drupal.example.com");
    expect(body.clients.cursor.config.mcpServers.drupal.env.MCP_CLIENT_ID).toBe("content-agent");
    expect(body.clients.claude.config.mcpServers.drupal.command).toBe("npx");
    expect(body.clients.claude.config.mcpServers.drupal.env.MCP_CLIENT_ID).toBe("content-agent");
    expect(body.clients.cursor.projectPath).toMatch(/\.cursor\/mcp\.json$/);
    expect(body.clients.claude.projectPath).toMatch(/\.mcp\.json$/);
    expect(existsSync(join(dir, ".cursor", "mcp.json"))).toBe(false);
  });

  it("unreachable host skips whoami and contract_ready instead of throwing", () => {
    const result = runWizard([
      "--yes",
      "--json",
      "--host", "http://127.0.0.1:1",
      "--output", dir,
    ]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.checks.whoami.status).toBe("skip");
    expect(body.checks.contract_ready.status).toBe("skip");
    expect(body.checks.whoami.detail).toMatch(/unreachable/i);
    expect(body.checks.contract_ready.next).toMatch(/Tailscale|VPN|local/);
    expect(result.stderr).not.toMatch(/Unhandled|TypeError/);
    expect(result.status).toBe(0);
  });

  it("--write without --yes refuses to clobber an existing file", () => {
    const target = join(dir, ".cursor", "mcp.json");
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: "keep" } } }, null, 2));

    const result = runWizard([
      "--write",
      "--json",
      "--host", "https://drupal.example.com",
      "--clients", "cursor",
      "--output", dir,
    ]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.writes[0].status).toBe("skipped");
    const kept = JSON.parse(readFileSync(target, "utf8"));
    expect(kept.mcpServers.other.command).toBe("keep");
    expect(kept.mcpServers.drupal).toBeUndefined();
  });

  it("--write --yes merges the drupal server without dropping other entries", () => {
    const target = join(dir, ".cursor", "mcp.json");
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: "keep" } } }, null, 2));

    const result = runWizard([
      "--yes",
      "--write",
      "--json",
      "--host", "https://drupal.example.com",
      "--clients", "cursor",
      "--output", dir,
    ]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.writes[0].status).toBe("written");
    const merged = JSON.parse(readFileSync(target, "utf8"));
    expect(merged.mcpServers.other.command).toBe("keep");
    expect(merged.mcpServers.drupal.command).toBe("npx");
  });

  it("rejects an invalid transport without crashing", () => {
    const result = runWizard(["--yes", "--transport", "ftp", "--output", dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/transport must be stdio\|https/);
  });

  it("https + oauth snippets use a url (no secret values)", () => {
    const result = runWizard([
      "--yes",
      "--json",
      "--transport", "https",
      "--host", "https://mcp.example.ts.net:3443/mcp",
      "--drupal-url", "https://drupal.example.com",
      "--auth", "oauth",
      "--output", dir,
    ]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.clients.cursor.config.mcpServers.drupal.url).toBe("https://mcp.example.ts.net:3443/mcp");
    expect(body.clients.claude.config.mcpServers.drupal.type).toBe("http");
    const dumped = JSON.stringify(body);
    expect(dumped).not.toMatch(/client_secret|CLIENT_SECRET|apiToken":\s*"[^$<]/);
  });

  it("--preset public-https is gated, forces oauth, and maps to https snippets", () => {
    const result = runWizard([
      "--yes",
      "--json",
      "--preset", "public-https",
      "--host", "https://mcp.example.com/mcp",
      "--output", dir,
    ]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.answers.preset).toBe("public-https");
    expect(body.answers.gated).toBe(true);
    expect(body.answers.transport).toBe("https");
    expect(body.answers.auth).toBe("oauth");
    expect(body.clients.cursor.config.mcpServers.drupal.url).toMatch(/\/mcp$/);
    expect(body.clients.cursor.config.mcpServers.drupal.headers).toBeUndefined();
    expect(result.stderr).toMatch(/gated\/later|not a public SaaS/i);
  });

  it("--preset public-https rejects explicit --auth token", () => {
    const result = runWizard([
      "--yes",
      "--json",
      "--preset", "public-https",
      "--auth", "token",
      "--host", "https://mcp.example.com/mcp",
      "--output", dir,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires --auth oauth/i);
  });

  it("stdio + --auth oauth is rejected with an actionable error", () => {
    const result = runWizard([
      "--yes",
      "--json",
      "--transport", "stdio",
      "--auth", "oauth",
      "--host", "https://drupal.example.com",
      "--output", dir,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/stdio \+ --auth oauth/i);
  });

  it("--preset tailscale stays stdio and VPN-required", () => {
    const result = runWizard([
      "--yes",
      "--json",
      "--preset", "tailscale",
      "--host", "https://drupal.example.ts.net",
      "--output", dir,
    ]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.answers.preset).toBe("tailscale");
    expect(body.answers.gated).toBe(false);
    expect(body.answers.transport).toBe("stdio");
    expect(body.clients.cursor.config.mcpServers.drupal.command).toBe("npx");
  });
});
