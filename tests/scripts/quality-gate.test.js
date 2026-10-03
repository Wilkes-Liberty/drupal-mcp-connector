import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

/** Single-line `run:` commands. Ignores step names and multiline `run: |` blocks. */
function runCommands(workflow) {
  return workflow.split("\n").flatMap((line) => {
    const match = line.match(/^\s*run:\s*(\S.*)$/);
    if (!match || match[1].trim() === "|") return [];
    return [match[1].trim()];
  });
}

describe("advertised quality gate", () => {
  const pkg = JSON.parse(read("package.json"));
  const ci = read(".github/workflows/ci.yml");
  const release = read(".github/workflows/release.yml");
  const agents = read("AGENTS.md");
  const contributing = read("CONTRIBUTING.md");

  it("check is lint + high-severity audit + syntax-check + test", () => {
    expect(pkg.scripts.audit).toBe("npm audit --audit-level=high");
    expect(pkg.scripts.check).toBe(
      "npm run lint && npm run audit && npm run syntax-check && npm test",
    );
  });

  it("does not treat a step name as an executed command", () => {
    const namedOnly = [
      "      - name: npm run check",
      "        run: echo skipped",
    ].join("\n");
    expect(runCommands(namedOnly)).not.toContain("npm run check");
  });

  it("CI and release execute npm run check, and release does so before publish", () => {
    expect(runCommands(ci)).toContain("npm run check");
    expect(ci).toMatch(/^\s*name: Lint, Syntax & Unit \(Node 20\)\s*$/m);
    expect(ci).toMatch(/^permissions:\s*$/m);
    expect(ci).toMatch(/^\s*contents: read\s*$/m);
    expect(ci).toMatch(/^\s*actions: read\s*$/m);

    const releaseCommands = runCommands(release);
    const checkAt = releaseCommands.indexOf("npm run check");
    const publishAt = releaseCommands.findIndex((command) => command.startsWith("npm publish"));
    expect(checkAt).toBeGreaterThan(-1);
    expect(publishAt).toBeGreaterThan(checkAt);
  });

  it("docs name the same CI and release quality gate as the workflows", () => {
    expect(agents).toContain("lint + audit + syntax-check + test (CI and release quality gate)");
    expect(contributing).toContain("lint + audit + syntax-check + test (CI and release quality gate)");
    expect(contributing).toContain("re-runs `npm run check`");
  });
});
