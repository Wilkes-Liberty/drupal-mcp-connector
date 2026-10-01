import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * CLI smoke for the operator doctor (DEV-759).
 * Spawns the real bin / index entry.
 */

const doctorBin = fileURLToPath(new URL("../../bin/drupal-mcp-doctor.js", import.meta.url));
const indexBin = fileURLToPath(new URL("../../src/index.js", import.meta.url));

/**
 * @param {string[]} args
 * @param {{bin?: string, env?: NodeJS.ProcessEnv}} [opts]
 */
function runDoctor(args, opts = {}) {
  return spawnSync(process.execPath, [opts.bin || doctorBin, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    timeout: 20_000,
  });
}

describe("drupal-mcp-doctor CLI", () => {
  it("doctor --help prints usage and presets", () => {
    const help = runDoctor(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/PRIMARY FAILURE|first failing|next fix/i);
    expect(help.stdout).toMatch(/--json/);
    expect(help.stdout).toMatch(/local-stdio/);
    expect(help.stdout).toMatch(/public-https/);
    expect(help.stdout).toMatch(/gated/);
  });

  it("index.js doctor --help uses the same command", () => {
    const help = runDoctor(["doctor", "--help"], { bin: indexBin });
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/drupal-mcp-connector doctor/);
  });

  it("--json on a reserved host fails closed without fetching or leaking secrets", () => {
    const result = runDoctor([
      "--json",
      "--host", "https://drupal.example.com",
      "--token-env", "DRUPAL_API_TOKEN",
    ], { env: { ...process.env, DRUPAL_API_TOKEN: "must-not-appear-in-output" } });
    expect(result.status).toBe(1);
    const body = JSON.parse(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.primaryFailure.id).toBe("reachability");
    expect(body.checks.map((c) => c.id)).toEqual([
      "reachability",
      "auth",
      "agent_client",
      "allowlist",
      "readiness",
      "version_skew",
    ]);
    expect(result.stdout).not.toMatch(/must-not-appear-in-output/);
    expect(result.stderr).not.toMatch(/must-not-appear-in-output/);
  });

  it("human output names PRIMARY FAILURE and NEXT FIX", () => {
    const result = runDoctor(["--host", "https://drupal.example.com"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/PRIMARY FAILURE: reachability/);
    expect(result.stdout).toMatch(/NEXT FIX:/);
  });
});
