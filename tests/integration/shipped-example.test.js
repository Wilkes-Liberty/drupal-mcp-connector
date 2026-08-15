import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyStatic, isNeutralHost } from "../../src/lib/verify.js";

/**
 * The shipped example configuration is a claim: "this is what a secure,
 * tenant-neutral install looks like". A claim nobody checks is a wish, so the
 * verifier runs against the real file here, in CI, on every change (#180).
 */

const repoFile = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const readRepoFile = (relative) => readFileSync(repoFile(relative), "utf8");

/** The example with its documentation keys (leading underscore) stripped. */
function loadExample() {
  const raw = JSON.parse(readRepoFile("config/config.example.json"));
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !key.startsWith("_"))
          .map(([key, v]) => [key, strip(v)]),
      );
    }
    return value;
  };
  return strip(raw);
}

describe("config/config.example.json — the shipped secure default", () => {
  it("passes every static verification check", () => {
    const result = verifyStatic(loadExample(), { source: "config/config.example.json" });
    const failures = result.checks
      .filter((c) => c.status !== "pass")
      .map((c) => `${c.id} [${c.status}]: ${c.findings.join(" ")}`);
    expect(failures).toEqual([]);
    expect(result.summary.ok).toBe(true);
  });

  it("names no host outside the documentation-reserved ranges", () => {
    const raw = readRepoFile("config/config.example.json");
    const hosts = [...raw.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase());
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.filter((h) => !isNeutralHost(h))).toEqual([]);
  });

  it("carries no deployment-specific identifier in any shipped operator script", () => {
    // The example, the launcher and the deploy unit are all published: a real
    // estate's hostnames, Keychain item names or consumer ids must not ride
    // along in them. (Maintainer attribution in docs is a different thing and
    // is deliberately out of scope here.)
    const shipped = ["config/config.example.json", "bin/drupal-mcp-launch.sh", "deploy/launchd/run.sh"];
    const offenders = [];
    for (const path of shipped) {
      const text = readRepoFile(path);
      for (const [index, line] of text.split("\n").entries()) {
        if (/wilkesliberty|wilkes-liberty/i.test(line) && !/github\.com\/Wilkes-Liberty/i.test(line)) {
          offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives every tier its own principal and its own secret env var", () => {
    const example = loadExample();
    const sites = Object.values(example.sites ?? {});
    expect(sites.length).toBeGreaterThan(1);
    const clientIds = sites.map((s) => s.oauth?.clientId).filter(Boolean);
    const secretEnvs = sites.map((s) => s.oauth?.clientSecretEnv).filter(Boolean);
    expect(new Set(clientIds).size).toBe(clientIds.length);
    expect(new Set(secretEnvs).size).toBe(secretEnvs.length);
  });

  it("ships no secret value, only environment variable names", () => {
    const raw = readRepoFile("config/config.example.json");
    expect(raw).not.toMatch(/"clientSecret"\s*:/);
    expect(raw).not.toMatch(/"apiToken"\s*:/);
  });
});
