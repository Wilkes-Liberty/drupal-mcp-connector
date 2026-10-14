import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseWorkflowUses,
  resolveReference,
  resolveTag,
  collectWorkflowUses,
  createGitHubApi,
  lintActions,
  exitCodeFor,
  main,
} from "../../scripts/lint-actions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const SHA = "6f9f17788090df1f26f669e9d70d6ae9567deba6";
const OTHER = "0000000000000000000000000000000000000000";
const REPO = "repos/sigstore/cosign-installer";

/** Fake GitHub API: path -> { status, body }; anything else is a 404. */
function fakeApi(routes) {
  return async (path) => routes[path] ?? { status: 404, body: { message: "Not Found" } };
}

function commitOk() {
  return { [`${REPO}/commits/${SHA}`]: { status: 200, body: { sha: SHA } } };
}

function lightTag(name, sha = SHA) {
  return { [`${REPO}/git/ref/tags/${name}`]: { status: 200, body: { object: { type: "commit", sha } } } };
}

function workflowDir(text) {
  const dir = mkdtempSync(join(tmpdir(), "lint-actions-"));
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/x.yml"), text);
  return dir;
}

const entry = (ref, comment = "", path = "") => ({
  owner: "sigstore", repo: "cosign-installer", path, ref, comment, invalid: "",
});

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
    expect(entries.every((e) => e.invalid === "")).toBe(true);
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

  it("marks a reference with no @ref invalid and keeps parsing the file", () => {
    const entries = parseWorkflowUses("- uses: actions/checkout\n- uses: actions/setup-node@v7\n", "x.yml");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ line: 1, invalid: expect.stringMatching(/owner\/repo/) });
    expect(entries[1]).toMatchObject({ line: 2, invalid: "", ref: "v7" });
  });

  it("marks owner, repository, path, or ref segments that would change the API route invalid", () => {
    const cases = {
      "../repo@v1": /owner/,
      "owner/re%2Fpo@v1": /repository/,
      "owner/repo/../../x@v1": /path .* "\.\."/,
      "owner/repo/a//b@v1": /path .* empty/,
      "owner/repo@..": /ref .* "\.\."/,
      "owner/repo@a/./b": /ref .* "\."/,
    };
    for (const [spec, pattern] of Object.entries(cases)) {
      const [e] = parseWorkflowUses(`- uses: ${spec}\n`, "x.yml");
      expect(e.invalid, spec).toMatch(pattern);
    }
  });
});

describe("resolveTag", () => {
  it("follows a tag that points at another tag, down to the commit", async () => {
    const api = fakeApi({
      [`${REPO}/git/ref/tags/v3`]: { status: 200, body: { object: { type: "tag", sha: "outer" } } },
      [`${REPO}/git/tags/outer`]: { status: 200, body: { object: { type: "tag", sha: "inner" } } },
      [`${REPO}/git/tags/inner`]: { status: 200, body: { object: { type: "commit", sha: SHA } } },
    });
    expect(await resolveTag(api, "sigstore", "cosign-installer", "v3")).toBe(SHA);
  });

  it("looks a slash-containing tag up as path segments, not as one encoded segment", async () => {
    const api = fakeApi(lightTag("release/v1"));
    expect(await resolveTag(api, "sigstore", "cosign-installer", "release/v1")).toBe(SHA);
  });
});

describe("resolveReference", () => {
  it("fails a floating tag that upstream never published (#464)", async () => {
    const result = await resolveReference(fakeApi({}), entry("v4"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no such tag or branch/);
  });

  it("dereferences an annotated tag to its commit", async () => {
    const api = fakeApi({
      [`${REPO}/git/ref/tags/v3`]: { status: 200, body: { object: { type: "tag", sha: "tagobject" } } },
      [`${REPO}/git/tags/tagobject`]: { status: 200, body: { object: { type: "commit", sha: SHA } } },
    });
    expect(await resolveReference(api, entry("v3"))).toMatchObject({ ok: true, kind: "tag", sha: SHA });
  });

  it("falls back to a branch, including one with a slash, when no tag matches", async () => {
    const api = fakeApi({
      [`${REPO}/git/ref/heads/releases/v1`]: { status: 200, body: { object: { type: "commit", sha: SHA } } },
    });
    expect(await resolveReference(api, entry("releases/v1"))).toMatchObject({ ok: true, kind: "branch", sha: SHA });
  });

  it("reports an unknown commit SHA as missing (GitHub answers 422, not 404)", async () => {
    const api = fakeApi({
      [`${REPO}/commits/${OTHER}`]: { status: 422, body: { message: "No commit found for SHA: " + OTHER } },
    });
    const result = await resolveReference(api, entry(OTHER));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/^commit not found/);
  });

  it("accepts a SHA pin whose full version comment points at that commit", async () => {
    const api = fakeApi({ ...commitOk(), ...lightTag("v4.1.2") });
    expect(await resolveReference(api, entry(SHA, "v4.1.2"))).toMatchObject({ ok: true, kind: "commit", sha: SHA });
  });

  it("fails a SHA pin whose version comment points at a different commit", async () => {
    const api = fakeApi({ ...commitOk(), ...lightTag("v4.1.1", OTHER) });
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
    const result = await resolveReference(fakeApi(commitOk()), entry(SHA, "v4"));
    expect(result).toMatchObject({ ok: true, kind: "commit", sha: SHA });
  });

  it("accepts a sub-path that exists at the ref, as a file or a directory", async () => {
    const api = fakeApi({
      ...lightTag("v3"),
      [`${REPO}/contents/.github/workflows/ok.yml?ref=${SHA}`]: { status: 200, body: { type: "file" } },
      [`${REPO}/contents/actions/setup?ref=${SHA}`]: { status: 200, body: [] },
    });
    expect(await resolveReference(api, entry("v3", "", ".github/workflows/ok.yml"))).toMatchObject({ ok: true, sha: SHA });
    expect(await resolveReference(api, entry("v3", "", "actions/setup"))).toMatchObject({ ok: true, sha: SHA });
  });

  it("fails a sub-path that does not exist at the ref", async () => {
    const result = await resolveReference(fakeApi(lightTag("v3")), entry("v3", "", ".github/workflows/nope.yml"));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/nope\.yml does not exist/);
  });

  it("does not report a rate limit or outage as a missing reference", async () => {
    const api = fakeApi({
      [`${REPO}/git/ref/tags/v3`]: { status: 403, body: { message: "API rate limit exceeded" } },
    });
    await expect(resolveReference(api, entry("v3"))).rejects.toThrow(/403.*rate limit/);
  });
});

describe("createGitHubApi", () => {
  function response(status, body, headers = {}) {
    return {
      status,
      headers: new Headers(headers),
      json: async () => body,
      body: { cancel: async () => {} },
    };
  }

  function apiWith(sequence, options = {}) {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      const next = sequence[Math.min(seen.length, sequence.length) - 1];
      if (next instanceof Error) {
        throw next;
      }
      return next;
    };
    return { seen, api: createGitHubApi({ fetchImpl, token: "", retries: 3, retryDelayMs: 0, baseUrl: "https://gh.test", ...options }) };
  }

  it("retries a 5xx and returns the eventual answer", async () => {
    const { seen, api } = apiWith([response(503, null), response(503, null), response(200, { sha: SHA })]);
    expect(await api("repos/a/b/commits/x")).toEqual({ status: 200, body: { sha: SHA } });
    expect(seen).toEqual(Array(3).fill("https://gh.test/repos/a/b/commits/x"));
  });

  it("retries 429 and 403-with-Retry-After, honouring the header", async () => {
    const started = Date.now();
    const { seen, api } = apiWith([
      response(429, null, { "retry-after": "0" }),
      response(403, { message: "secondary rate limit" }, { "retry-after": "0" }),
      response(200, { ok: true }),
    ]);
    expect((await api("x")).status).toBe(200);
    expect(seen).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("returns a plain 403 and a 404 at once without retrying", async () => {
    for (const status of [403, 404]) {
      const { seen, api } = apiWith([response(status, { message: "nope" })]);
      expect((await api("x")).status).toBe(status);
      expect(seen).toHaveLength(1);
    }
  });

  it("returns the last 5xx once retries are exhausted instead of throwing", async () => {
    const { seen, api } = apiWith([response(502, null)]);
    expect((await api("x")).status).toBe(502);
    expect(seen).toHaveLength(3);
  });

  it("gives up with an error after repeated network failures", async () => {
    const { api } = apiWith([new Error("ECONNRESET")], { retries: 2 });
    await expect(api("x")).rejects.toThrow(/unreachable.*ECONNRESET/);
  });
});

describe("lintActions", () => {
  it("reports every reference even when one lookup throws or one line is invalid", async () => {
    const dir = workflowDir([
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/checkout@v7",
      "      - uses: actions/setup-node@v7",
      "      - uses: sigstore/cosign-installer@v4",
      "      - uses: actions/checkout",
    ].join("\n"));
    const api = fakeApi({
      "repos/actions/checkout/git/ref/tags/v7": { status: 200, body: { object: { type: "commit", sha: SHA } } },
      "repos/actions/setup-node/git/ref/tags/v7": { status: 502, body: null },
    });
    const report = await lintActions(dir, api);
    expect(report).toMatchObject({ total: 4, invalid: 1, missing: 1, errors: 1 });
    expect(report.lines.find((l) => l.startsWith("ok"))).toMatch(/actions\/checkout@v7/);
    expect(report.lines.find((l) => l.startsWith("ERROR"))).toMatch(/actions\/setup-node@v7: GitHub API 502/);
    expect(report.lines.find((l) => l.startsWith("MISSING"))).toMatch(/cosign-installer@v4: no such tag/);
    expect(report.lines.find((l) => l.startsWith("INVALID"))).toMatch(/actions\/checkout: .*x\.yml:7/);
  });
});

describe("exit codes", () => {
  it("rank unknown results above missing ones", () => {
    expect(exitCodeFor({ errors: 1, missing: 1, invalid: 1 })).toBe(2);
    expect(exitCodeFor({ errors: 0, missing: 1, invalid: 0 })).toBe(1);
    expect(exitCodeFor({ errors: 0, missing: 0, invalid: 1 })).toBe(1);
    expect(exitCodeFor({ errors: 0, missing: 0, invalid: 0 })).toBe(0);
  });

  it("main prints every line and the matching summary", async () => {
    const out = [];
    const err = [];
    const lint = async () => ({ total: 2, invalid: 0, missing: 1, errors: 0, lines: ["ok a", "MISSING b"] });
    const code = await main(["/nowhere"], { lint, out: (s) => out.push(s), err: (s) => err.push(s) });
    expect(code).toBe(1);
    expect(out).toEqual(["ok a\n", "MISSING b\n"]);
    expect(err.join("")).toMatch(/1 of 2 .* do not resolve/);
  });
});

describe("this repository's workflows", () => {
  it("pin cosign-installer to a commit SHA with a full version comment, not a floating major", () => {
    const cosign = collectWorkflowUses(root).filter((e) => e.repo === "cosign-installer");
    expect(cosign.length).toBeGreaterThan(0);
    for (const e of cosign) {
      expect(e.invalid).toBe("");
      expect(e.ref).toMatch(/^[0-9a-f]{40}$/);
      expect(e.comment).toMatch(/^v\d+\.\d+\.\d+$/);
    }
  });

  it("contain no invalid references", () => {
    expect(collectWorkflowUses(root).filter((e) => e.invalid)).toEqual([]);
  });
});
