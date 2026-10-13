import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  resolveReleaseChannel,
  assertImageTags,
  parseArgs,
  main,
} from "../../scripts/release-channel.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/release-channel.js");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

describe("resolveReleaseChannel", () => {
  it("sends a final X.Y.Z to npm latest and allows floating GHCR tags", () => {
    const channel = resolveReleaseChannel("5.1.0", { allowFloating: true });
    expect(channel).toMatchObject({
      version: "5.1.0",
      isSemver: true,
      isPrerelease: false,
      npmDistTag: "latest",
      githubPrerelease: false,
      floatingTags: true,
      major: "5",
      minor: "1",
      semverValue: "v5.1.0",
    });
  });

  it("sends every semver prerelease to npm next and never floats GHCR tags", () => {
    for (const input of ["5.1.0-rc.1", "v5.1.0-pre.2", "5.1.0-alpha.1", "5.1.0-beta"]) {
      const channel = resolveReleaseChannel(input, { allowFloating: true });
      expect(channel.npmDistTag).toBe("next");
      expect(channel.githubPrerelease).toBe(true);
      expect(channel.isPrerelease).toBe(true);
      expect(channel.floatingTags).toBe(false);
    }
  });

  it("treats +build metadata as a final release, not a prerelease", () => {
    const channel = resolveReleaseChannel("5.1.0+build.9", { allowFloating: true });
    expect(channel.npmDistTag).toBe("latest");
    expect(channel.isPrerelease).toBe(false);
    expect(channel.floatingTags).toBe(true);
  });

  it("does not float tags on a backfill of a final version", () => {
    const channel = resolveReleaseChannel("5.0.0");
    expect(channel.npmDistTag).toBe("latest");
    expect(channel.floatingTags).toBe(false);
  });

  it("does not treat a SHA-like ref as a prerelease", () => {
    const channel = resolveReleaseChannel("sha-abcdef123456", { allowFloating: true });
    expect(channel.isSemver).toBe(false);
    expect(channel.isPrerelease).toBe(false);
    expect(channel.floatingTags).toBe(false);
  });
});

describe("assertImageTags", () => {
  const image = "ghcr.io/wilkes-liberty/drupal-mcp-connector";

  it("rejects :latest, :X, and :X.Y on an rc", () => {
    const channel = resolveReleaseChannel("5.1.0-rc.1", { allowFloating: true });
    expect(() =>
      assertImageTags(
        `${image}:5.1.0-rc.1\n${image}:v5.1.0-rc.1\n${image}:latest`,
        channel,
      ),
    ).toThrow(/must not take :latest/);
    expect(() =>
      assertImageTags(`${image}:5.1.0-rc.1\n${image}:v5.1.0-rc.1\n${image}:5`, channel),
    ).toThrow(/must not take :5/);
    expect(() =>
      assertImageTags(`${image}:5.1.0-rc.1\n${image}:v5.1.0-rc.1\n${image}:5.1`, channel),
    ).toThrow(/must not take :5\.1/);
    expect(() =>
      assertImageTags(`${image}:5.1.0-rc.1\n${image}:v5.1.0-rc.1`, channel),
    ).not.toThrow();
  });

  it("requires :latest, :X, and :X.Y on a floating final", () => {
    const channel = resolveReleaseChannel("5.1.0", { allowFloating: true });
    expect(() =>
      assertImageTags(`${image}:5.1.0\n${image}:v5.1.0`, channel),
    ).toThrow(/final image must take :latest/);
    expect(() =>
      assertImageTags(
        `${image}:5.1.0\n${image}:v5.1.0\n${image}:5.1\n${image}:5\n${image}:latest`,
        channel,
      ),
    ).not.toThrow();
  });
});

describe("CLI", () => {
  it("parses --expect-npm-tag and --allow-floating", () => {
    expect(parseArgs(["--version", "5.1.0-rc.1", "--expect-npm-tag", "next"])).toMatchObject({
      version: "5.1.0-rc.1",
      expectNpmTag: "next",
    });
    expect(parseArgs(["--version", "5.1.0", "--allow-floating"]).allowFloating).toBe(true);
  });

  it("fails --expect-npm-tag when the channel disagrees", () => {
    expect(() =>
      main(["--version", "5.1.0-rc.1", "--expect-npm-tag", "latest"], {
        stdout: { write() {} },
      }),
    ).toThrow(/must publish to npm dist-tag latest/);
    expect(
      main(["--version", "5.1.0-rc.1", "--expect-npm-tag", "next"], {
        stdout: { write() {} },
      }).npmDistTag,
    ).toBe("next");
    expect(
      main(["--version", "5.1.0", "--expect-npm-tag", "latest"], {
        stdout: { write() {} },
      }).npmDistTag,
    ).toBe("latest");
  });

  it("writes GitHub Actions outputs when asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-channel-"));
    const output = join(dir, "github-output");
    writeFileSync(output, "");
    main(["--version", "5.1.0-rc.1", "--allow-floating", "--github-output"], {
      stdout: { write() {} },
      env: { GITHUB_OUTPUT: output },
    });
    const body = readFileSync(output, "utf8");
    expect(body).toContain("npm_dist_tag=next");
    expect(body).toContain("github_prerelease=true");
    expect(body).toContain("floating_tags=false");
  });

  it("the committed script agrees when invoked as the workflow does", () => {
    const rc = execFileSync(
      process.execPath,
      [script, "--version", "5.1.0-rc.1", "--allow-floating", "--expect-npm-tag", "next"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(rc).floatingTags).toBe(false);
    const final = execFileSync(
      process.execPath,
      [script, "--version", "5.1.0", "--allow-floating", "--expect-npm-tag", "latest"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(final).floatingTags).toBe(true);
  });
});

describe("workflow wiring (DEV-841)", () => {
  const release = read(".github/workflows/release.yml");
  const ci = read(".github/workflows/ci.yml");

  it("publishes npm with the derived dist-tag, never a bare latest", () => {
    expect(release).toContain("scripts/release-channel.js");
    expect(release).toMatch(/npm publish --access public --tag "\$NPM_DIST_TAG"/);
    expect(release).not.toMatch(/^\s*run:\s*npm publish --access public\s*$/m);
  });

  it("marks the GitHub Release as a prerelease when the channel says so", () => {
    expect(release).toMatch(/--prerelease/);
    expect(release).toContain("github_prerelease");
  });

  it("CI dry-runs rc vs final so a prerelease cannot take latest", () => {
    expect(ci).toMatch(/name: Release channel \(dry-run\)/);
    expect(ci).toContain("--expect-npm-tag next");
    expect(ci).toContain("--expect-npm-tag latest");
    expect(ci).toContain("--assert-image-tags");
  });
});
