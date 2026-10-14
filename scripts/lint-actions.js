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
 * Every reference is reported, each as exactly one of:
 *   ok       resolved;
 *   INVALID  the line cannot be a GitHub reference (exit 1);
 *   MISSING  GitHub has no such commit, tag, branch, or path (exit 1);
 *   ERROR    the lookup failed after retries; the answer is unknown (exit 2).
 * Needs network. `GITHUB_TOKEN` or `GH_TOKEN` raises the rate limit and is
 * required to read a private action repository. `GITHUB_API_URL` is
 * honoured for GitHub Enterprise Server. Exports for tests; side effects run
 * only when executed directly.
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
const MAX_RETRY_AFTER_MS = 30000;
const MAX_TAG_DEPTH = 5;
const NOT_VISIBLE = "(or the repository is not visible to this token)";

function invalidName(value) {
  return !NAME_SEGMENT.test(value) || value === "." || value === "..";
}

function hasDotSegment(value) {
  return value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

/** Encode a ref or path for a URL, keeping `/` as a path separator. */
function encodeSegments(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

/**
 * Extract action references from one workflow's text. A line that looks like
 * a `uses:` but cannot be a GitHub reference is returned with `invalid` set
 * instead of thrown, so the rest of the file is still checked.
 *
 * @param {string} text Workflow YAML.
 * @param {string} [file] Display name for diagnostics.
 * @returns {Array<{
 *   file: string, line: number, spec: string, owner: string, repo: string,
 *   path: string, ref: string, comment: string, invalid: string,
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
    const entry = {
      file,
      line: index + 1,
      spec,
      owner: "",
      repo: "",
      path: "",
      ref: "",
      comment: match[2] ?? "",
      invalid: "",
    };
    const parts = spec.match(REMOTE_SPEC);
    if (!parts) {
      entry.invalid = "not of the form owner/repo[/path]@ref";
    } else {
      entry.owner = parts[1];
      entry.repo = parts[2];
      entry.path = parts[3].replace(/^\//, "");
      entry.ref = parts[4];
      if (invalidName(entry.owner)) {
        entry.invalid = `owner "${entry.owner}" is not a valid GitHub name`;
      } else if (invalidName(entry.repo)) {
        entry.invalid = `repository "${entry.repo}" is not a valid GitHub name`;
      } else if (entry.path && hasDotSegment(entry.path)) {
        entry.invalid = `path "${entry.path}" contains an empty, "." or ".." segment`;
      } else if (hasDotSegment(entry.ref)) {
        entry.invalid = `ref "${entry.ref}" contains an empty, "." or ".." segment`;
      }
    }
    found.push(entry);
  });
  return found;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function retryAfterMs(response) {
  const header = response.headers && response.headers.get ? response.headers.get("retry-after") : null;
  if (header === null || header === undefined) {
    return null;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function shouldRetry(response) {
  if (response.status >= 500 || response.status === 429) {
    return true;
  }
  // Secondary rate limits answer 403 with Retry-After; a plain 403 is final.
  return response.status === 403 && retryAfterMs(response) !== null;
}

async function discard(response) {
  try {
    if (response.body && typeof response.body.cancel === "function") {
      await response.body.cancel();
    }
  } catch {
    // Nothing to release.
  }
}

/**
 * Build a GitHub REST client over global fetch.
 *
 * Retries 5xx, 429, 403-with-Retry-After, and network errors. The wait is
 * the Retry-After header when present (capped), else linear backoff. After
 * the last attempt the response is returned as-is, so callers can tell "not
 * found" from "unavailable".
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
        const wait = response ? retryAfterMs(response) : null;
        if (response) {
          await discard(response);
        }
        await sleep(wait ?? retryDelayMs * attempt);
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
 * Resolve a tag name to the commit it points at, dereferencing annotated
 * tags (including a tag that points at another tag).
 *
 * @param {(path: string) => Promise<{ status: number, body: any }>} api
 * @param {string} owner
 * @param {string} repo
 * @param {string} tag Tag name without `refs/tags/`.
 * @returns {Promise<string|null>} Commit SHA, or null when the tag is absent
 *   or does not end at a commit.
 */
export async function resolveTag(api, owner, repo, tag) {
  const ref = await getOrNull(api, `repos/${owner}/${repo}/git/ref/tags/${encodeSegments(tag)}`);
  let object = ref ? ref.object : null;
  for (let depth = 0; object && object.type === "tag" && depth < MAX_TAG_DEPTH; depth += 1) {
    const annotated = await getOrNull(api, `repos/${owner}/${repo}/git/tags/${object.sha}`);
    object = annotated ? annotated.object : null;
  }
  return object && object.type === "commit" ? object.sha : null;
}

async function pathExists(api, owner, repo, path, sha) {
  const found = await getOrNull(api, `repos/${owner}/${repo}/contents/${encodeSegments(path)}?ref=${sha}`);
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
      return { ok: false, kind: "commit", sha: "", reason: `commit not found ${NOT_VISIBLE}` };
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
      const branch = await getOrNull(api, `repos/${owner}/${repo}/git/ref/heads/${encodeSegments(ref)}`);
      if (!branch || !branch.object) {
        return { ok: false, kind: "", sha: "", reason: `no such tag or branch ${NOT_VISIBLE}` };
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
 * each reference lands in exactly one of `ok`, `INVALID`, `MISSING`, `ERROR`.
 *
 * @param {string} root Repository root.
 * @param {(path: string) => Promise<{ status: number, body: any }>} api
 * @returns {Promise<{
 *   total: number, invalid: number, missing: number, errors: number, lines: string[],
 * }>}
 */
export async function lintActions(root, api) {
  const entries = collectWorkflowUses(root);
  const unique = new Map();
  for (const entry of entries) {
    const key = entry.invalid
      ? `invalid:${entry.spec}`
      : `${entry.owner}/${entry.repo}/${entry.path}@${entry.ref}#${entry.comment}`;
    if (!unique.has(key)) {
      unique.set(key, { entry, sites: [] });
    }
    unique.get(key).sites.push(`${entry.file}:${entry.line}`);
  }

  const results = await Promise.all(
    [...unique.values()].map(async ({ entry, sites }) => {
      if (entry.invalid) {
        return { entry, sites };
      }
      try {
        return { entry, sites, result: await resolveReference(api, entry) };
      } catch (error) {
        return { entry, sites, error };
      }
    }),
  );

  const lines = [];
  let invalid = 0;
  let missing = 0;
  let errors = 0;
  for (const { entry, sites, result, error } of results) {
    const where = sites.join(", ");
    if (entry.invalid) {
      invalid += 1;
      lines.push(`INVALID  ${entry.spec}: ${entry.invalid} (${where})`);
      continue;
    }
    const subpath = entry.path ? `/${entry.path}` : "";
    const label = `${entry.owner}/${entry.repo}${subpath}@${entry.ref}${entry.comment ? ` # ${entry.comment}` : ""}`;
    if (error) {
      errors += 1;
      lines.push(`ERROR    ${label}: ${error.message} (${where})`);
    } else if (result.ok) {
      lines.push(`ok       ${label} -> ${result.kind} ${result.sha}`);
    } else {
      missing += 1;
      lines.push(`MISSING  ${label}: ${result.reason} (${where})`);
    }
  }
  return { total: unique.size, invalid, missing, errors, lines };
}

/**
 * Map a lint report to the process exit code.
 *
 * @param {{ invalid: number, missing: number, errors: number }} report
 * @returns {0|1|2} 0 when all resolve, 1 when any is invalid or missing,
 *   2 when any lookup failed (takes precedence, since the result is unknown).
 */
export function exitCodeFor(report) {
  if (report.errors > 0) {
    return 2;
  }
  if (report.missing > 0 || report.invalid > 0) {
    return 1;
  }
  return 0;
}

/**
 * CLI entry point. Prints one line per reference and a summary.
 *
 * @param {string[]} [argv] Optional repository root as the first argument.
 * @param {{
 *   lint?: typeof lintActions, out?: (s: string) => void, err?: (s: string) => void,
 * }} [deps] Injection points for tests.
 * @returns {Promise<number>} See {@link exitCodeFor}.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const root = argv[0] ?? process.cwd();
  const lint = deps.lint ?? lintActions;
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const err = deps.err ?? ((s) => process.stderr.write(s));
  const report = await lint(root, createGitHubApi());
  for (const line of report.lines) {
    out(`${line}\n`);
  }
  const code = exitCodeFor(report);
  const { total, invalid, missing, errors } = report;
  if (code === 2) {
    err(`lint:actions: ${errors} of ${total} lookup(s) failed; ${missing} missing, ${invalid} invalid.\n`);
  } else if (code === 1) {
    err(`lint:actions: ${missing + invalid} of ${total} action reference(s) do not resolve (${missing} missing, ${invalid} invalid).\n`);
  } else {
    out(`lint:actions: all ${total} action reference(s) resolve.\n`);
  }
  return code;
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
