import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseWorkflowUses,
  resolveReference,
  collectWorkflowUses,
} from "../../scripts/lint-actions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const SHA = "6f9f17788090df1f26f669e9d70d6ae9567deba6";
const OTHER = "0000000000000000000000000000000000000000";

/** Fake GitHub API: path -> { status, body }; anything else is a 404. */
function fakeApi(routes) {
  return async (path) => routes[path] ?? { status: 404, body: { message: "Not Found" } };
}

describe("parseWorkflowUses", () => {
  it("reads step-level, job-level, quoted, and sub-path references", () => {
    const text = [
      "jobs:",
      "  a:",
      "    uses: Wilkes-Liberty/shared-ci/.github/workflows/attribution.yml@v1",
      "  b:",
      "    steps:",
      "      - uses: actions/checkout@v7",
      '      - uses: "docker/login-action@v4"',
      `      - uses: sigstore/cosign-installer@${SHA} # v4.1.2`,
    ].join("\n");
    const entries = parseWorkflowUses(text, "x.yml");
    expect(entries.map((e) => `${e.owner}/${e.repo}@${e.ref}`)).toEqual([
      "Wilkes-Liberty/shared-ci@v1",
      "actions/checkout@v7",
      "docker/login-action@v4",
      `sigstore/cosign-installer@${SHA}`,
    ]);
    expect(entries[0].path).toBe(".github/workflows/attribution.yml");
    expect(entries[3].comment).toBe("v4.1.2");
    expect(entries[3].line).toBe(8);
  });

  it("skips local and docker references instead of treating them as repositories", () => {
    const text = "steps:\n  - uses: ./.github/actions/local\n  - uses: docker://alpine:3.20\n";
    expect(parseWorkflowUses(text)).toEqual([]);
  });

  it("rejects a reference with no @ref rather than silently passing it", () => {
    expect(() => parseWorkflowUses("- uses: actions/checkout\n", "x.yml")).toThrow(/x\.yml:1/);
  });
});

describe("resolveReference", () => {
  const entry = (ref, comment = "") => ({
    owner: "sigstore", repo: "cosign-installer", path: "", ref, comment,
  });

  it("fails a floating tag that upstream never published (#464)", async () => {
    const api = fakeApi({});
    const result = await resolveReference(api, entry("v4"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no such tag or branch/);
  });

  it("dereferences an annotated tag to its commit", async () => {
    const api = fakeApi({
      "repos/sigstore/cosign-installer/git/ref/tags/v3": {
        status: 200, body: { object: { type: "tag", sha: "tagobject" } },
      },
      "repos/sigstore/cosign-installer/git/tags/tagobject": {
        status: 200, body: { object: { type: "commit", sha: SHA } },
      },
    });
    expect(await resolveReference(api, entry("v3"))).toMatchObject({ ok: true, kind: "tag", sha: SHA });
  });

  it("falls back to a branch when no tag matches", async () => {
    const api = fakeApi({
      "repos/sigstore/cosign-installer/git/ref/heads/main": {
        status: 200, body: { object: { type: "commit", sha: SHA } },
      },
    });
    expect(await resolveReference(api, entry("main"))).toMatchObject({ ok: true, kind: "branch", sha: SHA });
  });

  it("fails a SHA pin whose version comment points at a different commit", async () => {
    const api = fakeApi({
      [`repos/sigstore/cosign-installer/commits/${SHA}`]: { status: 200, body: { sha: SHA } },
      "repos/sigstore/cosign-installer/git/ref/tags/v4.1.1": {
        status: 200, body: { object: { type: "commit", sha: OTHER } },
      },
    });
    const result = await resolveReference(api, entry(SHA, "v4.1.1"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/v4\.1\.1 points at/);
  });

  it("fails a SHA pin whose version comment names a tag that does not exist", async () => {
    const api = fakeApi({
      [`repos/sigstore/cosign-installer/commits/${SHA}`]: { status: 200, body: { sha: SHA } },
    });
    const result = await resolveReference(api, entry(SHA, "v9.9.9"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/v9\.9\.9 does not exist/);
  });

  it("does not report a rate limit or outage as a missing reference", async () => {
    const api = fakeApi({
      "repos/sigstore/cosign-installer/git/ref/tags/v3": {
        status: 403, body: { message: "API rate limit exceeded" },
      },
    });
    await expect(resolveReference(api, entry("v3"))).rejects.toThrow(/403.*rate limit/);
  });
});

describe("this repository's workflows", () => {
  it("pin cosign-installer to a commit SHA with a version comment, not a floating major", () => {
    const cosign = collectWorkflowUses(root).filter((e) => e.repo === "cosign-installer");
    expect(cosign.length).toBeGreaterThan(0);
    for (const e of cosign) {
      expect(e.ref).toMatch(/^[0-9a-f]{40}$/);
      expect(e.comment).toMatch(/^v\d+\.\d+\.\d+$/);
    }
  });
});
