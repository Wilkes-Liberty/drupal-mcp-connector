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

/**
 * Split a workflow into job-id → YAML block. Job ids are the two-space
 * mapping keys under `jobs:`; a rename or indent change fails the
 * Node 20 / Node 24 assertions below instead of matching the wrong job.
 */
function workflowJobs(workflow) {
  const header = workflow.match(/^jobs:\s*$/m);
  if (!header) return {};
  const body = workflow.slice(workflow.indexOf("\n", header.index) + 1);
  const jobs = {};
  let currentId = null;
  let lines = [];
  const flush = () => {
    if (currentId) jobs[currentId] = lines.join("\n");
  };
  for (const line of body.split("\n")) {
    const idMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (idMatch) {
      flush();
      currentId = idMatch[1];
      lines = [line];
      continue;
    }
    if (currentId) lines.push(line);
  }
  flush();
  return jobs;
}

/** Every `node-version:` pin in a job, in source order. */
function nodeVersions(block) {
  return [...block.matchAll(/^\s*node-version:\s*['"]?([^'"\s]+)/gm)].map(
    (match) => match[1],
  );
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

  it("required CI job runs Node 20, matching engines.node and the check name", () => {
    // Floor advertised to npm; CI must actually install that major.
    expect(pkg.engines.node).toBe(">=20.0.0");

    const jobs = workflowJobs(ci);
    const required = jobs["lint-and-syntax"];
    expect(required, "missing lint-and-syntax job").toBeTruthy();
    expect(required).toMatch(/^\s{4}name: Lint, Syntax & Unit \(Node 20\)\s*$/m);
    // Fail closed: any extra pin in this job (e.g. silently moving to 24)
    // is a mismatch with the required-check name.
    expect(nodeVersions(required)).toEqual(["20"]);
    expect(runCommands(required)).toContain("npm run check");

    // Same gate on 24 LTS, different display name, so branch protection
    // that keys on "(Node 20)" does not start requiring 24.
    const node24 = jobs["lint-and-syntax-node24"];
    expect(node24, "missing lint-and-syntax-node24 job").toBeTruthy();
    expect(node24).toMatch(/^\s{4}name: Lint, Syntax & Unit \(Node 24\)\s*$/m);
    expect(nodeVersions(node24)).toEqual(["24"]);
    expect(runCommands(node24)).toContain("npm run check");
  });

  it("docs name the same CI and release quality gate as the workflows", () => {
    expect(agents).toContain("lint + audit + syntax-check + test (CI and release quality gate)");
    expect(contributing).toContain("lint + audit + syntax-check + test (CI and release quality gate)");
    expect(contributing).toContain("re-runs `npm run check`");
    // engines.node, getting-started, and versioning all advertise 20+.
    expect(contributing).toContain("Node.js 20+");
    expect(read("docs/getting-started.md")).toContain("Node.js 20+");
    expect(read("docs/versioning.md")).toMatch(/\*\*Node\.js 20\+\*\*/);
  });
});
