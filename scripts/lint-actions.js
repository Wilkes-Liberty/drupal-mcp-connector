#!/usr/bin/env node
/**
 * lint-actions.js — resolve every `uses:` reference under .github/workflows
 * against GitHub, so a reference that does not exist fails on the pull
 * request instead of on the release tag.
 *
 * Background (#464): release.yml referenced `sigstore/cosign-installer@v4`.
 * Upstream never published a floating `v4` tag, so the GHCR image job died at
 * "Set up job" on the v5.0.0 tag, after npm had already published. Nothing
 * before the tag push reads action references; this script does.
 *
 * Rules, per `owner/repo[/path]@ref`:
 *   - a 40-hex ref must be a reachable commit. If the line carries a
 *     `# vX.Y.Z` comment, that tag must point at the same commit, so the
 *     human-readable version cannot drift from the pin;
 *   - any other ref must be a tag or a branch on that repository.
 * `./local` and `docker://` references are skipped.
 *
 * Needs network. `GITHUB_TOKEN` or `GH_TOKEN` raises the rate limit and is
 * required to read a private action repository. Exports for tests; side
 * effects run only when executed directly.
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WORKFLOWS_DIR = ".github/workflows";
const USES_LINE = /^\s*(?:-\s+)?uses:\s*["']?([^"'\s#]+)["']?\s*(?:#\s*(\S+))?/;
const REMOTE_SPEC = /^([^/@\s]+)\/([^/@\s]+)((?:\/[^@\s]+)?)@(\S+)$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v?\d+(?:\.\d+){0,2}$/;

/**
 * Extract remote action references from one workflow's text.
 *
 * @param {string} text Workflow YAML.
 * @param {string} file Display name for diagnostics.
 * @returns {Array<{
 *   file: string, line: number, spec: string, owner: string, repo: string,
 *   path: string, ref: string, comment: string,
 * }>}
 */
export function parseWorkflowUses(text, file = "<text>") {
  const found = [];
  const lines = String(text ?? "").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const match = raw.match(USES_LINE);
    if (!match) {
      return;
    }
    const spec = match[1];
    if (spec.startsWith("./") || spec.startsWith("docker://")) {
      return;
    }
    const parts = spec.match(REMOTE_SPEC);
    if (!parts) {
      throw new Error(`${file}:${index + 1}: cannot parse uses: ${spec}`);
    }
    found.push({
      file,
      line: index + 1,
      spec,
      owner: parts[1],
      repo: parts[2],
      path: parts[3].replace(/^\//, ""),
      ref: parts[4],
      comment: match[2] ?? "",
    });
  });
  return found;
}

/**
 * Build a GitHub REST client over global fetch.
 *
 * @param {{ token?: string, baseUrl?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {(path: string) => Promise<{ status: number, body: any }>}
 */
export function createGitHubApi(options = {}) {
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "drupal-mcp-connector lint-actions",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return async function api(path) {
    const response = await fetchImpl(`${baseUrl}/${path}`, { headers });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

async function getOrNull(api, path) {
  const { status, body } = await api(path);
  if (status === 200) {
    return body;
  }
  if (status === 404) {
    return null;
  }
  const detail = body && body.message ? ` (${body.message})` : "";
  throw new Error(`GitHub API ${status} for ${path}${detail}`);
}

/**
 * Resolve a tag name to the commit it points at, dereferencing annotated tags.
 *
 * @returns {Promise<string|null>} Commit SHA or null when the tag is absent.
 */
export async function resolveTag(api, owner, repo, tag) {
  const ref = await getOrNull(api, `repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (!ref) {
    return null;
  }
  if (ref.object && ref.object.type === "tag") {
    const annotated = await getOrNull(api, `repos/${owner}/${repo}/git/tags/${ref.object.sha}`);
    return annotated && annotated.object ? annotated.object.sha : null;
  }
  return ref.object ? ref.object.sha : null;
}

/**
 * Resolve one `owner/repo@ref` against GitHub.
 *
 * A 404 on every candidate yields `ok: false`; any other API failure throws,
 * so a rate limit or an outage is never reported as a missing reference.
 *
 * @returns {Promise<{ ok: boolean, kind: string, sha: string, reason: string }>}
 */
export async function resolveReference(api, entry) {
  const { owner, repo, ref, comment } = entry;
  if (COMMIT_SHA.test(ref)) {
    const commit = await getOrNull(api, `repos/${owner}/${repo}/commits/${ref}`);
    if (!commit) {
      return { ok: false, kind: "commit", sha: "", reason: "commit not found" };
    }
    if (comment && VERSION_COMMENT.test(comment)) {
      const tagSha = await resolveTag(api, owner, repo, comment);
      if (!tagSha) {
        return { ok: false, kind: "commit", sha: commit.sha, reason: `comment tag ${comment} does not exist` };
      }
      if (tagSha !== commit.sha) {
        return {
          ok: false,
          kind: "commit",
          sha: commit.sha,
          reason: `comment tag ${comment} points at ${tagSha}, not ${commit.sha}`,
        };
      }
    }
    return { ok: true, kind: "commit", sha: commit.sha, reason: "" };
  }

  const tagSha = await resolveTag(api, owner, repo, ref);
  if (tagSha) {
    return { ok: true, kind: "tag", sha: tagSha, reason: "" };
  }
  const branch = await getOrNull(api, `repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`);
  if (branch && branch.object) {
    return { ok: true, kind: "branch", sha: branch.object.sha, reason: "" };
  }
  return { ok: false, kind: "", sha: "", reason: "no such tag or branch" };
}

/**
 * Read every workflow file and return parsed references.
 *
 * @param {string} root Repository root.
 */
export function collectWorkflowUses(root) {
  const dir = join(root, WORKFLOWS_DIR);
  const files = readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  const entries = [];
  for (const name of files) {
    const rel = `${WORKFLOWS_DIR}/${name}`;
    entries.push(...parseWorkflowUses(readFileSync(join(dir, name), "utf8"), rel));
  }
  return entries;
}

/**
 * Resolve all references, deduplicated by `owner/repo@ref#comment`.
 *
 * @returns {Promise<{ failures: number, lines: string[] }>}
 */
export async function lintActions(root, api) {
  const entries = collectWorkflowUses(root);
  const unique = new Map();
  for (const entry of entries) {
    const key = `${entry.owner}/${entry.repo}@${entry.ref}#${entry.comment}`;
    if (!unique.has(key)) {
      unique.set(key, { entry, sites: [] });
    }
    unique.get(key).sites.push(`${entry.file}:${entry.line}`);
  }

  const lines = [];
  let failures = 0;
  const results = await Promise.all(
    [...unique.values()].map(async ({ entry, sites }) => ({
      entry,
      sites,
      result: await resolveReference(api, entry),
    })),
  );
  for (const { entry, sites, result } of results) {
    const label = `${entry.owner}/${entry.repo}@${entry.ref}${entry.comment ? ` # ${entry.comment}` : ""}`;
    if (result.ok) {
      lines.push(`ok       ${label} -> ${result.kind} ${result.sha}`);
    } else {
      failures += 1;
      lines.push(`MISSING  ${label}: ${result.reason} (${sites.join(", ")})`);
    }
  }
  return { failures, lines, total: unique.size };
}

export async function main(argv = process.argv.slice(2)) {
  const root = argv[0] ?? process.cwd();
  const api = createGitHubApi();
  const { failures, lines, total } = await lintActions(root, api);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  if (failures > 0) {
    process.stderr.write(`lint:actions: ${failures} of ${total} action reference(s) do not resolve.\n`);
    return 1;
  }
  process.stdout.write(`lint:actions: all ${total} action reference(s) resolve.\n`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      process.stderr.write(`lint:actions: ${error.message}\n`);
      process.exit(2);
    });
}
