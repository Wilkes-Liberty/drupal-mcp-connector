import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startHangingDrupal, writeCatalogConfig } from "../helpers/real-chain-drupal.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const closers = [];

afterEach(async () => {
  while (closers.length) await closers.pop()();
});

describe("stdio catalog shutdown (DEV-1019)", () => {
  it("exits after stdin closes while catalog warmup is still in flight", async () => {
    const hanging = await startHangingDrupal();
    closers.push(() => hanging.close());
    const root = mkdtempSync(resolve(tmpdir(), `drupal-mcp-exit-${process.pid}-`));
    closers.push(async () => { rmSync(root, { recursive: true, force: true }); });
    writeCatalogConfig(root, hanging.baseUrl, 1);
    const child = spawn(process.execPath, [resolve(repoRoot, "src/index.js")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        MCP_TRANSPORT: "stdio",
        HOME: root,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    closers.push(async () => {
      if (!child.killed) child.kill("SIGKILL");
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.stdin.end();
    const started = Date.now();
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), 5_000);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false });
      });
    });
    expect(exit.timedOut).toBe(false);
    expect(exit.signal).toBeNull();
    expect(exit.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);
});
