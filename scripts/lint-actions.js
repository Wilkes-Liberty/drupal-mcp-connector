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
 *   - a 40-hex ref must be a commit GitHub can find for that repository
 *     (the commits endpoint also sees the repository's fork network, so this
 *     proves existence, not that the commit is on a branch or tag). If the
 *     line carries a full `# vX.Y.Z` comment, that tag must point at the same
 *     commit, so the human-readable version cannot drift from the pin.
 *     Major-only comments such as `# v4` are floating and are not checked;
 *   - any other ref must be a tag or a branch on that repository;
 *   - when the reference names a path (a reusable workflow or a nested
 *     action), that path must exist at the resolved commit.
 * `./local` and `docker://` references are skipped.
 *
 * Every reference is reported. A missing reference is `MISSING` (exit 1); an
 * API failure that survives retries is `ERROR` (exit 2) and is never reported
 * as missing. Needs network. `GITHUB_TOKEN` or `GH_TOKEN` raises the rate
 * limit and is required to read a private action repository.
 * `GITHUB_API_URL` is honoured for GitHub Enterprise Server. Exports for
 * tests; side effects run only when executed directly.
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WORKFLOWS_DIR = ".github/workflows";
const USES_LINE = /^\s*(?:-\s+)?uses:\s*["']?([^"'\s#]+)["']?\s*(?:#\s*(\S+))?/;
const REMOTE_SPEC = /^([^/@\s]+)\/([^/@\s]+)((?:\/[^@\s]+)?)@(\S+)$/;
const NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** Only a full version pins a commit. `v4` or `4.1` floats and is not checked. */
const EXACT_VERSION_COMMENT = /^v?\d+\.\d+\.\d+$/;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

function assertName(value, what, where) {
  if (!NAME_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${where}: ${what} "${value}" is not a valid GitHub name`);
  }
}

/**
 * Extract remote action references from one workflow's text.
 *
 * @param {string} text Workflow YAML.
 * @param {string} [file] Display name for diagnostics.
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
    const where = `${file}:${index + 1}`;
    const parts = spec.match(REMOTE_SPEC);
    if (!parts) {
      throw new Error(`${where}: cannot parse uses: ${spec}`);
    }
    assertName(parts[1], "owner", where);
    assertName(parts[2], "repository", where);
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetry(response) {
  if (response.status >= 500 || response.status === 429) {
    return true;
  }
  // Secondary rate limits answer 403 with Retry-After.
  return response.status === 403 && response.headers.has("retry-after");
}

/**
 * Build a GitHub REST client over global fetch.
 *
 * Retries 5xx, 429, 403-with-Retry-After, and network errors with linear
 * backoff. A response that is still not usable after the last attempt is
 * returned as-is, so callers can distinguish "not found" from "unavailable".
 *
 * @param {{
 *   token?: string, baseUrl?: string, fetchImpl?: typeof fetch,
 *   retries?: number, retryDelayMs?: number,
 * }} [options]
 * @returns {(path: string) => Promise<{ status: number, body: any }>}
 */
export function createGitHubApi(options = {}) {
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const baseUrl = (options.baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "drupal-mcp-connector lint-actions",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return async function api(path) {
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/${path}`, { headers });
      } catch (error) {
        lastError = error;
        response = null;
      }
      if (response && (!shouldRetry(response) || attempt === retries)) {
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return { status: response.status, body };
      }
      if (attempt < retries) {
        await sleep(retryDelayMs * attempt);
      }
    }
    throw new Error(`GitHub API unreachable for ${path}: ${lastError ? lastError.message : "no response"}`);
  };
}

async function getOrNull(api, path, notFound = [404]) {
  const { status, body } = await api(path);
  if (status === 200) {
    return body;
  }
  if (notFound.includes(status)) {
    return null;
  }
  const detail = body && body.message ? ` (${body.message})` : "";
  throw new Error(`GitHub API ${status} for ${path}${detail}`);
}

/**
 * Resolve a tag name to the commit it points at, dereferencing annotated tags.
 *
 * @param {(path: string) => Promise<{ status: number, body: any }>} api
 * @param {string} owner
 * @param {string} repo
 * @param {string} tag Tag name without `refs/tags/`.
 * @returns {Promise<string|null>} Commit SHA, or null when the tag is absent.
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

async function pathExists(api, owner, repo, path, sha) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const found = await getOrNull(api, `repos/${owner}/${repo}/contents/${encoded}?ref=${sha}`);
  return found !== null;
}

/**
 * Resolve one parsed reference against GitHub.
 *
 * A 404 (or 422 for an unknown commit SHA) yields `ok: false`; any other API
 * failure throws, so a rate limit or an outage is never reported as missing.
 *
 * @param {(path: string) => Promise<{ status: number, body: any }>} api
 * @param {ReturnType<typeof parseWorkflowUses>[number]} entry
 * @returns {Promise<{ ok: boolean, kind: string, sha: string, reason: string }>}
 */
export async function resolveReference(api, entry) {
  const { owner, repo, path, ref, comment } = entry;
  let kind = "";
  let sha = "";

  if (COMMIT_SHA.test(ref)) {
    // GitHub answers 422 "No commit found for SHA" for a well-formed unknown SHA.
    const commit = await getOrNull(api, `repos/${owner}/${repo}/commits/${ref}`, [404, 422]);
    if (!commit) {
      return { ok: false, kind: "commit", sha: "", reason: "commit not found" };
    }
    kind = "commit";
    sha = commit.sha;
    if (comment && EXACT_VERSION_COMMENT.test(comment)) {
      const tagSha = await resolveTag(api, owner, repo, comment);
      if (!tagSha) {
        return { ok: false, kind, sha, reason: `comment tag ${comment} does not exist` };
      }
      if (tagSha !== sha) {
        return { ok: false, kind, sha, reason: `comment tag ${comment} points at ${tagSha}, not ${sha}` };
      }
    }
  } else {
    const tagSha = await resolveTag(api, owner, repo, ref);
    if (tagSha) {
      kind = "tag";
      sha = tagSha;
    } else {
      const branch = await getOrNull(api, `repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`);
      if (!branch || !branch.object) {
        return { ok: false, kind: "", sha: "", reason: "no such tag or branch" };
      }
      kind = "branch";
      sha = branch.object.sha;
    }
  }

  if (path && !(await pathExists(api, owner, repo, path, sha))) {
    return { ok: false, kind, sha, reason: `path ${path} does not exist at ${sha}` };
  }
  return { ok: true, kind, sha, reason: "" };
}

/**
 * Read every workflow file under `.github/workflows` and return parsed references.
 *
 * @param {string} root Repository root.
 * @returns {ReturnType<typeof parseWorkflowUses>}
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
 * Resolve all references in a repository, deduplicated by
 * `owner/repo/path@ref#comment`. One lookup failing never hides the others:
 * each reference lands in exactly one of `ok`, `MISSING`, or `ERROR`.
 *
 * @param {string} root Repository root.
 * @param {(path: string) => Promise<{ status: number, body: any }>} api
 * @returns {Promise<{ total: number, missing: number, errors: number, lines: string[] }>}
 */
export async function lintActions(root, api) {
  const entries = collectWorkflowUses(root);
  const unique = new Map();
  for (const entry of entries) {
    const key = `${entry.owner}/${entry.repo}/${entry.path}@${entry.ref}#${entry.comment}`;
    if (!unique.has(key)) {
      unique.set(key, { entry, sites: [] });
    }
    unique.get(key).sites.push(`${entry.file}:${entry.line}`);
  }

  const results = await Promise.all(
    [...unique.values()].map(async ({ entry, sites }) => {
      try {
        return { entry, sites, result: await resolveReference(api, entry) };
      } catch (error) {
        return { entry, sites, error };
      }
    }),
  );

  const lines = [];
  let missing = 0;
  let errors = 0;
  for (const { entry, sites, result, error } of results) {
    const subpath = entry.path ? `/${entry.path}` : "";
    const label = `${entry.owner}/${entry.repo}${subpath}@${entry.ref}${entry.comment ? ` # ${entry.comment}` : ""}`;
    if (error) {
      errors += 1;
      lines.push(`ERROR    ${label}: ${error.message} (${sites.join(", ")})`);
    } else if (result.ok) {
      lines.push(`ok       ${label} -> ${result.kind} ${result.sha}`);
    } else {
      missing += 1;
      lines.push(`MISSING  ${label}: ${result.reason} (${sites.join(", ")})`);
    }
  }
  return { total: unique.size, missing, errors, lines };
}

/**
 * CLI entry point. Prints one line per reference and a summary.
 *
 * @param {string[]} [argv] Optional repository root as the first argument.
 * @returns {Promise<number>} 0 when all resolve, 1 when any is missing,
 *   2 when any lookup failed (takes precedence, since the result is unknown).
 */
export async function main(argv = process.argv.slice(2)) {
  const root = argv[0] ?? process.cwd();
  const api = createGitHubApi();
  const { total, missing, errors, lines } = await lintActions(root, api);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  if (errors > 0) {
    process.stderr.write(`lint:actions: ${errors} of ${total} lookup(s) failed; ${missing} reference(s) missing.\n`);
    return 2;
  }
  if (missing > 0) {
    process.stderr.write(`lint:actions: ${missing} of ${total} action reference(s) do not resolve.\n`);
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
