import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * DEV-751 Brief A: local/stdio Cursor plugin skeleton only.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function readText(rel) {
  return readFileSync(join(root, rel), "utf8");
}

const LIVE_HOST = /mcp\.wilkesliberty\.com|mcp\.example\.com/i;
const SECRETISH = /sk-|your-token-here|Bearer [A-Za-z0-9._-]{12,}/i;

describe("Cursor plugin scaffold (DEV-751 Brief A)", () => {
  const pkg = readJson("package.json");
  const plugin = readJson(".cursor-plugin/plugin.json");
  const mcp = readJson("mcp.json");
  const skill = readText("skills/drupal-mcp-stdio/SKILL.md");
  const privacy = readText("PRIVACY.md");
  const readme = readText("README.md");
  const security = readText("SECURITY.md");

  it("has a kebab-case Cursor manifest with MIT metadata and no remote url", () => {
    expect(plugin.name).toBe("drupal-mcp-connector");
    expect(plugin.name).toMatch(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/);
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.license).toBe("MIT");
    expect(plugin.homepage).toMatch(/github\.com\/Wilkes-Liberty\/drupal-mcp-connector/);
    expect(plugin.repository).toMatch(/github\.com\/Wilkes-Liberty\/drupal-mcp-connector/);
    expect(plugin.keywords).toEqual(expect.arrayContaining(["drupal", "mcp", "stdio"]));
    expect(plugin.url).toBeUndefined();
    expect(plugin.mcpServers).toBeUndefined();
    expect(JSON.stringify(plugin)).not.toMatch(LIVE_HOST);
    expect(JSON.stringify(plugin)).not.toMatch(SECRETISH);
  });

  it("keeps root mcp.json stdio-only (npx, no url, no secrets, no live host)", () => {
    const server = mcp.mcpServers.drupal;
    expect(Object.keys(mcp.mcpServers)).toEqual(["drupal"]);
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "drupal-mcp-connector"]);
    expect(server.url).toBeUndefined();
    expect(server.env).toBeUndefined();
    expect(JSON.stringify(mcp)).not.toMatch(LIVE_HOST);
    expect(JSON.stringify(mcp)).not.toMatch(SECRETISH);
  });

  it("documents init --preset local-stdio, doctor, gated public-https, no SaaS URL", () => {
    expect(skill).toMatch(/npx -y drupal-mcp-connector init --preset local-stdio/);
    expect(skill).toMatch(/npx -y drupal-mcp-connector doctor/);
    expect(skill).toMatch(/requireGovernance: true/);
    expect(skill).toMatch(/public-https/);
    expect(skill).toMatch(/gated/);
    expect(skill).toMatch(/no Wilkes & Liberty SaaS MCP URL/i);
    expect(skill).not.toMatch(LIVE_HOST);
    expect(skill).not.toMatch(SECRETISH);
  });

  it("states local-process privacy and security@ contact", () => {
    expect(privacy).toMatch(/local process/i);
    expect(privacy).toMatch(/never logged/i);
    expect(privacy).toMatch(/security@wilkesliberty\.com/);
    expect(privacy).not.toMatch(SECRETISH);
  });

  it("adds a short Cursor plugin (stdio) README section; submit stays operator-only", () => {
    expect(readme).toMatch(/### Cursor plugin \(stdio\)/);
    expect(readme).toMatch(/npx -y drupal-mcp-connector init --preset local-stdio/);
    expect(readme).toMatch(/operator-only/);
    expect(readme).toMatch(/does not submit/i);
    expect(readme).toMatch(/public-https.*gated/s);
  });

  it("lists 3.x as the supported security line, not 0.x", () => {
    expect(security).toMatch(/\|\s*3\.x\s*\|/);
    expect(security).not.toMatch(/\|\s*0\.x\s*\|/);
  });

  it("does not ungated public-https", () => {
    const transports = readText("src/lib/transports.js");
    expect(transports).toMatch(/gated: true/);
    expect(transports).toMatch(/Do not invent a marketplace remote until Path B exists/);
  });
});
