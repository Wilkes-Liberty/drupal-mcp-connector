import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clients = [];

afterEach(async () => {
  while (clients.length) await clients.pop().close();
});

function stdioTransport() {
  return new StdioClientTransport({
    command: process.execPath,
    args: [resolve(repoRoot, "src/index.js")],
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      DRUPAL_BASE_URL: "http://127.0.0.1:8888",
      MCP_TRANSPORT: "stdio",
    },
    stderr: "pipe",
  });
}

describe("stdio transport integration", () => {
  it("serves a modern 2026 connection from the shared factory", async () => {
    const client = new Client(
      { name: "modern-stdio-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    );
    clients.push(client);

    await client.connect(stdioTransport());

    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect((await client.listResources()).resources.map((resource) => resource.uri)).toContain("drupal://sites");
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toContain("drupal-content-audit");
    expect(await client.callTool({ name: "drupal_list_sites", arguments: {} })).toMatchObject({
      content: [{ type: "text" }],
    });
  });

  it("preserves the legacy stdio connection on the same entry point", async () => {
    const client = new Client({ name: "legacy-stdio-test", version: "1.0.0" });
    clients.push(client);

    await client.connect(stdioTransport());

    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(await client.callTool({ name: "drupal_list_sites", arguments: {} })).toMatchObject({
      content: [{ type: "text" }],
    });
  });
});
