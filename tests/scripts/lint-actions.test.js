import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseWorkflowUses,
  resolveReference,
  collectWorkflowUses,
  createGitHubApi,
  lintActions,
} from "../../scripts/lint-actions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const SHA = "6f9f17788090df1f26f669e9d70d6ae9567deba6";
const OTHER = "0000000000000000000000000000000000000000";

/** Fake GitHub API: path -> { status, body }; anything else is a 404. */
function fakeApi(routes) {
  return async (path) => routes[path] ?? { status: 404, body: { message: "Not Found" } };
}

function commitOk() {
  return { [`repos/sigstore/cosign-installer/commits/${SHA}`]: { status: 200, body: { sha: SHA } } };
}

function workflowDir(text) {
  const dir = mkdtempSync(join(tmpdir(), "lint-actions-"));
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/x.yml"), text);
  return dir;
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

  it("rejects owner or repository names that could change the API path", () => {
    expect(() => parseWorkflowUses("- uses: ../repo@v1\n", "x.yml")).toThrow(/not a valid GitHub name/);
    expect(() => parseWorkflowUses("- uses: owner/re%2Fpo@v1\n", "x.yml")).toThrow(/not a valid GitHub name/);
  });
});

describe("resolveReference", () => {
  const entry = (ref, comment = "", path = "") => ({
    owner: "sigstore", repo: "cosign-installer", path, ref, comment,
  });

  it("fails a floating tag that upstream never published (#464)", async () => {
    const result = await resolveReference(fakeApi({}), entry("v4"));
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

  it("reports an unknown commit SHA as missing (GitHub answers 422, not 404)", async () => {
    const api = fakeApi({
      [`repos/sigstore/cosign-installer/commits/${OTHER}`]: {
        status: 422, body: { message: "No commit found for SHA: " + OTHER },
      },
    });
    const result = await resolveReference(api, entry(OTHER));
    expect(result).toMatchObject({ ok: false, reason: "commit not found" });
  });

  it("fails a SHA pin whose version comment points at a different commit", async () => {
    const api = fakeApi({
      ...commitOk(),
      "repos/sigstore/cosign-installer/git/ref/tags/v4.1.1": {
        status: 200, body: { object: { type: "commit", sha: OTHER } },
      },
    });
    const result = await resolveReference(api, entry(SHA, "v4.1.1"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/v4\.1\.1 points at/);
  });

  it("fails a SHA pin whose version comment names a tag that does not exist", async () => {
    const result = await resolveReference(fakeApi(commitOk()), entry(SHA, "v9.9.9"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/v9\.9\.9 does not exist/);
  });

  it("ignores a floating major-only comment so upstream releases cannot break unrelated PRs", async () => {
    // No tag route for v4: a strict check would fail; a floating comment must not be checked.
    const result = await resolveReference(fakeApi(commitOk()), entry(SHA, "v4"));
    expect(result).toMatchObject({ ok: true, kind: "commit", sha: SHA });
  });

  it("fails a reusable-workflow reference whose path does not exist at the ref", async () => {
    const api = fakeApi({
      "repos/sigstore/cosign-installer/git/ref/tags/v3": {
        status: 200, body: { object: { type: "commit", sha: SHA } },
      },
    });
    const result = await resolveReference(api, entry("v3", "", ".github/workflows/nope.yml"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/nope\.yml does not exist/);
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

describe("createGitHubApi", () => {
  function response(status, body, headers = {}) {
    return { status, headers: new Headers(headers), json: async () => body };
  }

  it("retries a 5xx and returns the eventual answer", async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return seen.length < 3 ? response(503, null) : response(200, { sha: SHA });
    };
    const api = createGitHubApi({ fetchImpl, token: "", retries: 3, retryDelayMs: 0, baseUrl: "https://gh.test" });
    expect(await api("repos/a/b/commits/x")).toEqual({ status: 200, body: { sha: SHA } });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe("https://gh.test/repos/a/b/commits/x");
  });

  it("returns a 404 at once without retrying", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return response(404, { message: "Not Found" }); };
    const api = createGitHubApi({ fetchImpl, token: "", retries: 3, retryDelayMs: 0 });
    expect((await api("x")).status).toBe(404);
    expect(calls).toBe(1);
  });

  it("gives up with an error after repeated network failures", async () => {
    const fetchImpl = async () => { throw new Error("ECONNRESET"); };
    const api = createGitHubApi({ fetchImpl, token: "", retries: 2, retryDelayMs: 0 });
    await expect(api("x")).rejects.toThrow(/unreachable.*ECONNRESET/);
  });
});

describe("lintActions", () => {
  it("reports every reference even when one lookup throws", async () => {
    const dir = workflowDir([
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/checkout@v7",
      "      - uses: actions/setup-node@v7",
      "      - uses: sigstore/cosign-installer@v4",
    ].join("\n"));
    const api = fakeApi({
      "repos/actions/checkout/git/ref/tags/v7": { status: 200, body: { object: { type: "commit", sha: SHA } } },
      "repos/actions/setup-node/git/ref/tags/v7": { status: 502, body: null },
    });
    const report = await lintActions(dir, api);
    expect(report).toMatchObject({ total: 3, missing: 1, errors: 1 });
    expect(report.lines.find((l) => l.startsWith("ok"))).toMatch(/actions\/checkout@v7/);
    expect(report.lines.find((l) => l.startsWith("ERROR"))).toMatch(/actions\/setup-node@v7: GitHub API 502/);
    expect(report.lines.find((l) => l.startsWith("MISSING"))).toMatch(/cosign-installer@v4: no such tag/);
  });
});

describe("this repository's workflows", () => {
  it("pin cosign-installer to a commit SHA with a full version comment, not a floating major", () => {
    const cosign = collectWorkflowUses(root).filter((e) => e.repo === "cosign-installer");
    expect(cosign.length).toBeGreaterThan(0);
    for (const e of cosign) {
      expect(e.ref).toMatch(/^[0-9a-f]{40}$/);
      expect(e.comment).toMatch(/^v\d+\.\d+\.\d+$/);
    }
  });
});
