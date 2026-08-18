import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The launcher cds, sets NODE_EXTRA_CA_CERTS when mkcert exists, warns when
 * the secret table and config.json share no env-var names, and execs node.
 * Keychain lookup stays in src/lib/load-secrets.js.
 */

const launcher = fileURLToPath(new URL("../../bin/drupal-mcp-launch.sh", import.meta.url));
let dir;

/**
 * @param {{ config?: object, secretsMap?: string }} [files]
 */
function runLauncher(files = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const envFile = join(dir, "env.txt");
  writeFileSync(join(bin, "node"), `#!/bin/sh\nenv > '${envFile}'\n`, { mode: 0o755 });
  chmodSync(join(bin, "node"), 0o755);

  const connectorRoot = join(dir, "connector");
  mkdirSync(join(connectorRoot, "bin"), { recursive: true });
  mkdirSync(join(connectorRoot, "src"), { recursive: true });
  mkdirSync(join(connectorRoot, "config"), { recursive: true });
  writeFileSync(join(connectorRoot, "src", "index.js"), "// stub\n");
  writeFileSync(join(connectorRoot, "bin", "launch.sh"), readFileSync(launcher, "utf8"), { mode: 0o755 });
  if (files.config) {
    writeFileSync(join(connectorRoot, "config", "config.json"), JSON.stringify(files.config));
  }
  if (files.secretsMap !== undefined) {
    writeFileSync(join(connectorRoot, "config", "secrets.map"), files.secretsMap);
  }

  const launched = spawnSync("/bin/sh", [join(connectorRoot, "bin", "launch.sh")], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir },
    encoding: "utf8",
  });
  if (launched.status !== 0) {
    throw new Error(launched.stderr || `launcher exited ${launched.status}`);
  }
  const env = Object.fromEntries(
    readFileSync(envFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { env, stderr: launched.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-launcher-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bin/drupal-mcp-launch.sh", () => {
  it("execs node from the connector root so config.json resolves", () => {
    const { env } = runLauncher();
    expect(env.PWD === join(dir, "connector") || env.PWD?.endsWith("/connector")).toBe(true);
  });

  it("warns on stderr when the shipped table matches no config env names, and still exits 0", () => {
    const { stderr } = runLauncher({
      config: {
        sites: {
          prod: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } },
          admin: { oauth: { clientSecretEnv: "MCP_AGENT_ADMIN_SECRET" } },
        },
      },
    });
    expect(stderr).toMatch(/drupal-mcp-launch: no secret-table entries match/);
    expect(stderr).toMatch(/MCP_AGENT_CLIENT_SECRET/);
    expect(stderr).toMatch(/MCP_AGENT_ADMIN_SECRET/);
    expect(stderr).toMatch(/config\/secrets\.map is absent/);
    expect(stderr).toMatch(/fail closed/);
    expect(stderr).not.toMatch(/drupal-mcp-launch:.*\n.*drupal-mcp-launch:/);
  });

  it("does not warn per missing Keychain item when the table overlaps config", () => {
    const { stderr } = runLauncher({
      config: {
        sites: {
          prod: { oauth: { clientSecretEnv: "MCP_CONTENT_PRODUCTION_SECRET" } },
          admin: { oauth: { clientSecretEnv: "MCP_ADMIN_BREAKGLASS_SECRET" } },
        },
      },
    });
    expect(stderr).not.toMatch(/drupal-mcp-launch:/);
  });

  it("does not warn when secrets.map names the config vars", () => {
    const { stderr } = runLauncher({
      config: {
        sites: { prod: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } } },
      },
      secretsMap: "MCP_AGENT_CLIENT_SECRET=drupal-mcp-agent-secret\n",
    });
    expect(stderr).not.toMatch(/drupal-mcp-launch:/);
  });

  it("names secrets.map when that file exists but matches nothing", () => {
    const { stderr } = runLauncher({
      config: {
        sites: { prod: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } } },
      },
      secretsMap: "MCP_OTHER=drupal-mcp-other\n",
    });
    expect(stderr).toMatch(/config\/secrets\.map does not name them/);
  });

  it("collects apiTokenEnv as well as clientSecretEnv", () => {
    const { stderr } = runLauncher({
      config: {
        sites: {
          prod: { oauth: { clientSecretEnv: "MCP_AGENT_CLIENT_SECRET" } },
          token: { apiTokenEnv: "DRUPAL_TOKEN_PRODUCTION" },
        },
      },
    });
    expect(stderr).toMatch(/MCP_AGENT_CLIENT_SECRET/);
    expect(stderr).toMatch(/DRUPAL_TOKEN_PRODUCTION/);
  });
});
