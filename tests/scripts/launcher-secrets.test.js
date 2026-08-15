import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The launcher maps env var → Keychain item and exports the secrets it finds.
 *
 * Worth a test because the failure mode is silent: the obvious
 * `... | while read` form exports into a subshell that exits immediately, so
 * every secret ends up unset while the script still succeeds and the connector
 * simply cannot authenticate (#180).
 */

const launcher = fileURLToPath(new URL("../../bin/drupal-mcp-launch.sh", import.meta.url));
let dir;

/**
 * Runs the launcher's secret-sourcing half with a stub `security` on PATH and
 * a stub `node` that prints the environment instead of starting the server.
 *
 * @param {object} options
 * @param {Record<string,string>} options.keychain Item name → secret value.
 * @param {string} [options.secretsMap] Contents of config/secrets.map.
 * @returns {Record<string,string>} The environment the launcher exec'd with.
 */
function runLauncher({ keychain, secretsMap }) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });

  // Stub `security`: prints the value for a known item, exits 1 otherwise —
  // exactly how the real one behaves for a missing item.
  const cases = Object.entries(keychain)
    .map(([item, value]) => `    ${item}) printf '%s' '${value}' ;;`)
    .join("\n");
  writeFileSync(
    join(bin, "security"),
    `#!/bin/sh\n# stub\nitem=""\nwhile [ $# -gt 0 ]; do\n  case "$1" in -s) item="$2"; shift 2 ;; *) shift ;; esac\ndone\ncase "$item" in\n${cases}\n    *) exit 1 ;;\nesac\n`,
    { mode: 0o755 },
  );

  // Stub `node`: dumps the env the launcher exec'd with.
  const envFile = join(dir, "env.txt");
  writeFileSync(join(bin, "node"), `#!/bin/sh\nenv > '${envFile}'\n`, { mode: 0o755 });
  chmodSync(join(bin, "security"), 0o755);
  chmodSync(join(bin, "node"), 0o755);

  // The launcher cd's to its own parent, so run a copy inside the sandbox.
  const connectorRoot = join(dir, "connector");
  mkdirSync(join(connectorRoot, "bin"), { recursive: true });
  mkdirSync(join(connectorRoot, "config"), { recursive: true });
  writeFileSync(join(connectorRoot, "bin", "launch.sh"), readFileSync(launcher, "utf8"), { mode: 0o755 });
  if (secretsMap !== undefined) {
    writeFileSync(join(connectorRoot, "config", "secrets.map"), secretsMap);
  }

  execFileSync("/bin/sh", [join(connectorRoot, "bin", "launch.sh")], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
  });

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
  it("exports a secret it finds — in the parent shell, not a subshell", () => {
    const env = runLauncher({
      keychain: { "drupal-mcp-content-production": "prod-secret-value" },
    });
    expect(env.MCP_CONTENT_PRODUCTION_SECRET).toBe("prod-secret-value");
  });

  it("skips a missing item silently and still exports the ones present", () => {
    const env = runLauncher({
      keychain: { "drupal-mcp-developer-development": "dev-secret-value" },
    });
    expect(env.MCP_DEVELOPER_DEVELOPMENT_SECRET).toBe("dev-secret-value");
    // Absent Keychain item — the break-glass tier stays inert.
    expect(env.MCP_ADMIN_BREAKGLASS_SECRET).toBeUndefined();
    expect(env.MCP_CONTENT_PRODUCTION_SECRET).toBeUndefined();
  });

  it("exports every tier when every item is present", () => {
    const env = runLauncher({
      keychain: {
        "drupal-mcp-content-production": "a",
        "drupal-mcp-content-staging": "b",
        "drupal-mcp-developer-development": "c",
        "drupal-mcp-admin-breakglass": "d",
      },
    });
    expect(env.MCP_CONTENT_PRODUCTION_SECRET).toBe("a");
    expect(env.MCP_CONTENT_STAGING_SECRET).toBe("b");
    expect(env.MCP_DEVELOPER_DEVELOPMENT_SECRET).toBe("c");
    expect(env.MCP_ADMIN_BREAKGLASS_SECRET).toBe("d");
  });

  it("lets a per-machine table replace the shipped one, comments and all", () => {
    const env = runLauncher({
      keychain: { "my-estate-content": "own-value", "drupal-mcp-content-production": "shipped-value" },
      secretsMap: "# my machine\nMY_CONTENT_SECRET=my-estate-content\n\n",
    });
    expect(env.MY_CONTENT_SECRET).toBe("own-value");
    // The shipped default table is replaced, not merged.
    expect(env.MCP_CONTENT_PRODUCTION_SECRET).toBeUndefined();
  });

  it("ignores malformed lines instead of failing the launch", () => {
    const env = runLauncher({
      keychain: { "item-a": "value-a" },
      secretsMap: "not-a-pair\nGOOD_VAR=item-a\n   \n=missing-var\nMISSING_ITEM=\n",
    });
    expect(env.GOOD_VAR).toBe("value-a");
  });
});
