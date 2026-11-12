import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import {
  checkDependencyEngines,
  formatMismatch,
  productionEngineMismatches,
} from "../../scripts/check-dependency-engines.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

const GRAPHQL_17 = "^22.0.0 || ^24.0.0 || >=26.0.0";
const GRAPHQL_16 = "^12.22.0 || ^14.16.0 || ^16.0.0 || >=17.0.0";
const OURS = ">=20.0.0";

describe("productionEngineMismatches", () => {
  it("reports graphql 17 engines that drop Node 20", () => {
    const lock = {
      packages: {
        "": { engines: { node: OURS } },
        "node_modules/graphql": { version: "17.1.0", engines: { node: GRAPHQL_17 } },
      },
    };
    expect(productionEngineMismatches(OURS, lock)).toEqual([
      { id: "node_modules/graphql", version: "17.1.0", engines: GRAPHQL_17 },
    ]);
  });

  it("accepts graphql 16 engines that include Node 20", () => {
    const lock = {
      packages: {
        "node_modules/graphql": { version: "16.15.0", engines: { node: GRAPHQL_16 } },
      },
    };
    expect(productionEngineMismatches(OURS, lock)).toEqual([]);
  });

  it("skips devDependencies and packages with no engines.node", () => {
    const lock = {
      packages: {
        "node_modules/eslint": {
          version: "10.0.0",
          dev: true,
          engines: { node: ">=22" },
        },
        "node_modules/ajv": { version: "8.20.0" },
      },
    };
    expect(productionEngineMismatches(OURS, lock)).toEqual([]);
  });

  it("does not treat overlap at Node 22 as covering the advertised floor", () => {
    // Intersects would hide #544: graphql 17 and >=20.0.0 both include 22+.
    expect(semver.intersects(OURS, GRAPHQL_17)).toBe(true);
    expect(semver.subset(OURS, GRAPHQL_17)).toBe(false);
    expect(semver.subset(OURS, GRAPHQL_16)).toBe(true);
  });
});

describe("formatMismatch", () => {
  it("strips the lockfile node_modules prefix", () => {
    expect(formatMismatch({
      id: "node_modules/graphql",
      version: "17.1.0",
      engines: GRAPHQL_17,
    })).toBe(`graphql@17.1.0 engines.node ${GRAPHQL_17}`);
  });
});

describe("published graphql range (#544)", () => {
  const pkg = JSON.parse(read("package.json"));

  it("keeps the runtime graphql range on 16.x so npm install cannot pick 17", () => {
    const range = pkg.dependencies.graphql;
    expect(semver.satisfies("16.15.0", range)).toBe(true);
    expect(semver.intersects(range, ">=17.0.0")).toBe(false);
  });

  it("covers this package's engines.node in the lockfile", () => {
    const { ours, mismatches } = checkDependencyEngines(root);
    expect(ours).toBe(pkg.engines.node);
    expect(mismatches, mismatches.map(formatMismatch).join("\n")).toEqual([]);
  });

  it("tells Dependabot not to bump graphql to 17+", () => {
    const dependabot = read(".github/dependabot.yml");
    expect(dependabot).toMatch(/dependency-name:\s*graphql/);
    expect(dependabot).toMatch(/versions:\s*\[">=17\.0\.0"\]/);
  });
});
