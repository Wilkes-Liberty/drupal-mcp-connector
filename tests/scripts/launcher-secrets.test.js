import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The launcher only cds, sets NODE_EXTRA_CA_CERTS when mkcert exists, and
 * execs node. Secret loading is in src/lib/load-secrets.js so a client that
 * spawns `node src/index.js` cannot skip it.
 */

const launcher = fileURLToPath(new URL("../../bin/drupal-mcp-launch.sh", import.meta.url));
let dir;

function runLauncher() {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const envFile = join(dir, "env.txt");
  writeFileSync(join(bin, "node"), `#!/bin/sh\nenv > '${envFile}'\n`, { mode: 0o755 });
  chmodSync(join(bin, "node"), 0o755);

  const connectorRoot = join(dir, "connector");
  mkdirSync(join(connectorRoot, "bin"), { recursive: true });
  mkdirSync(join(connectorRoot, "src"), { recursive: true });
  writeFileSync(join(connectorRoot, "src", "index.js"), "// stub\n");
  writeFileSync(join(connectorRoot, "bin", "launch.sh"), readFileSync(launcher, "utf8"), { mode: 0o755 });

  const launched = spawnSync("/bin/sh", [join(connectorRoot, "bin", "launch.sh")], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
    encoding: "utf8",
  });
  if (launched.status !== 0) {
    throw new Error(launched.stderr || `launcher exited ${launched.status}`);
  }
  return Object.fromEntries(
    readFileSync(envFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-launcher-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bin/drupal-mcp-launch.sh", () => {
  it("execs node from the connector root so config.json resolves", () => {
    const env = runLauncher();
    expect(env.PWD === join(dir, "connector") || env.PWD?.endsWith("/connector")).toBe(true);
  });
});
