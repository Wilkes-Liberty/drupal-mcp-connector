import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

describe("advertised quality gate", () => {
  const pkg = JSON.parse(read("package.json"));
  const ci = read(".github/workflows/ci.yml");
  const release = read(".github/workflows/release.yml");
  const agents = read("AGENTS.md");
  const contributing = read("CONTRIBUTING.md");

  it("check is lint + high-severity audit + syntax-check + test", () => {
    expect(pkg.scripts.audit).toBe("npm audit --audit-level=high");
    expect(pkg.scripts.check).toContain("npm run lint");
    expect(pkg.scripts.check).toContain("npm run audit");
    expect(pkg.scripts.check).toContain("npm run syntax-check");
    expect(pkg.scripts.check).toContain("npm test");
  });

  it("CI and release run npm run check, and release runs it before publish", () => {
    expect(ci).toContain("npm run check");
    expect(release).toContain("npm run check");
    expect(ci.indexOf("npm run check")).toBeGreaterThan(-1);
    expect(release.indexOf("npm run check")).toBeLessThan(release.indexOf("npm publish"));
  });

  it("docs name the same CI and release quality gate as the workflows", () => {
    expect(agents).toContain("lint + audit + syntax-check + test (CI and release quality gate)");
    expect(contributing).toContain("lint + audit + syntax-check + test (CI and release quality gate)");
    expect(contributing).toContain("re-runs `npm run check`");
  });
});
