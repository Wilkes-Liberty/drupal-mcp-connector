import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  startRealChainDrupal,
  writeCatalogConfig,
} from "../helpers/real-chain-drupal.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const closers = [];

afterEach(async () => {
  while (closers.length) await closers.pop()();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnCatalogStdio(options = {}) {
  const drupal = await startRealChainDrupal(13);
  closers.push(() => drupal.close());
  const root = mkdtempSync(joinTmp("drupal-mcp-catalog-"));
  closers.push(async () => { rmSync(root, { recursive: true, force: true }); });
  writeCatalogConfig(root, drupal.baseUrl, 13);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(repoRoot, "src/index.js")],
    cwd: root,
    env: {
      PATH: process.env.PATH,
      MCP_TRANSPORT: "stdio",
      HOME: root,
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "catalog-stdio-test", version: "1.0.0" },
    options.clientOptions ?? {},
  );
  const notifications = [];
  client.fallbackNotificationHandler = (notification) => {
    notifications.push(notification);
  };
  closers.push(async () => { await client.close(); });
  await client.connect(transport);
  return { client, drupal, notifications };
}

function joinTmp(prefix) {
  return resolve(tmpdir(), `${prefix}${process.pid}-${Date.now()}`);
}

function moduleToolCount(tools) {
  return tools.filter((tool) => /^drupal_module_read_ns\d+__item$/.test(tool.name)).length;
}

describe("stdio catalog list_changed (DEV-1019)", () => {
  it("delivers tools list_changed on 2025-11-25", async () => {
    const { client, notifications } = await spawnCatalogStdio();
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    const started = performance.now();
    const cold = await client.listTools();
    const coldMs = performance.now() - started;
    expect(coldMs).toBeLessThan(8_000);
    expect(moduleToolCount(cold.tools)).toBe(0);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (notifications.some((item) => item.method === "notifications/tools/list_changed")) break;
      await delay(50);
    }
    expect(notifications.some((item) => item.method === "notifications/tools/list_changed")).toBe(true);
    const line = `[DEV-1019] stdio 2025 cold list=${Math.round(coldMs)}ms moduleTools=${moduleToolCount(cold.tools)}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
  }, 40_000);

  it("waits for the real chain on 2026-07-28 without listen", async () => {
    const { client, notifications } = await spawnCatalogStdio({
      clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    });
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const started = performance.now();
    const cold = await client.listTools();
    const coldMs = performance.now() - started;
    expect(moduleToolCount(cold.tools)).toBe(13);
    expect(coldMs).toBeGreaterThan(5_000);
    expect(coldMs).toBeLessThan(25_000);
    expect(notifications.some((item) => item.method === "notifications/tools/list_changed")).toBe(false);
    const line = `[DEV-1019] stdio 2026 no-listen cold list=${Math.round(coldMs)}ms moduleTools=${moduleToolCount(cold.tools)}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
  }, 40_000);

  it("delivers tools list_changed on 2026-07-28 with ClientOptions.listChanged", async () => {
    let changed = 0;
    const { client } = await spawnCatalogStdio({
      clientOptions: {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        listChanged: {
          tools: {
            onChanged: (error) => {
              if (!error) changed += 1;
            },
          },
        },
      },
    });
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(client.autoOpenedSubscription).toBeDefined();
    const started = performance.now();
    const cold = await client.listTools();
    const coldMs = performance.now() - started;
    expect(coldMs).toBeLessThan(5_500);
    expect(moduleToolCount(cold.tools)).toBe(0);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && changed === 0) await delay(50);
    expect(changed).toBeGreaterThan(0);
    const notifyMs = performance.now() - started;
    const warm = await client.listTools();
    expect(moduleToolCount(warm.tools)).toBe(13);
    const line = `[DEV-1019] stdio 2026 listChanged first list=${Math.round(coldMs)}ms ` +
      `moduleTools=${moduleToolCount(cold.tools)} notify=${Math.round(notifyMs)}ms ` +
      `warm=${moduleToolCount(warm.tools)}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
  }, 40_000);

  it("uses the short wait when listen() runs before the first list", async () => {
    const { client, notifications } = await spawnCatalogStdio({
      clientOptions: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    });
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    const sub = await client.listen({ toolsListChanged: true, promptsListChanged: true });
    const started = performance.now();
    const cold = await client.listTools();
    const coldMs = performance.now() - started;
    expect(coldMs).toBeLessThan(5_500);
    expect(moduleToolCount(cold.tools)).toBe(0);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (notifications.some((item) => item.method === "notifications/tools/list_changed")) break;
      await delay(50);
    }
    expect(notifications.some((item) => item.method === "notifications/tools/list_changed")).toBe(true);
    const notifyMs = performance.now() - started;
    const warm = await client.listTools();
    expect(moduleToolCount(warm.tools)).toBe(13);
    const line = `[DEV-1019] stdio 2026 explicit-listen first list=${Math.round(coldMs)}ms ` +
      `moduleTools=${moduleToolCount(cold.tools)} notify=${Math.round(notifyMs)}ms ` +
      `warm=${moduleToolCount(warm.tools)}`;
    console.error(line);
    process.stdout.write(`${line}\n`);
    await sub.close();
  }, 40_000);
});
