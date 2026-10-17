#!/usr/bin/env node
/**
 * check-principal-key-vectors.js — the mirrored principal-key fixture must
 * match mcp_sentinel at the pinned tag. Companion extras stay local.
 *
 * CI fetches tests/fixtures/principal-key-vectors.json from
 * Wilkes-Liberty/mcp_sentinel at PRINCIPAL_KEY_VECTORS_SENTINEL_TAG and
 * diffs canonical JSON against the tree. A drift, a fetch failure, or a
 * name collision with the extra file fails the job.
 *
 * Needs network. GITHUB_TOKEN / GH_TOKEN raises the GitHub rate limit.
 * Side effects run only when executed directly.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- reads the repo's mirrored fixture and extra file from a caller-supplied root that tests pin to the workspace. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PRINCIPAL_KEY_VECTORS_EXTRA_FILE,
  PRINCIPAL_KEY_VECTORS_FILE,
  PRINCIPAL_KEY_VECTORS_SENTINEL_PATH,
  PRINCIPAL_KEY_VECTORS_SENTINEL_TAG,
} from "../src/lib/principal-key.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SENTINEL_REPO = "Wilkes-Liberty/mcp_sentinel";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const bag = new Map(Object.entries(value));
    return Object.fromEntries(
      [...bag.keys()].sort().map((key) => [key, stable(bag.get(key))]),
    );
  }
  return value;
}

/**
 * Compare two fixture payloads. Empty string means equal.
 *
 * @param {string} localRaw
 * @param {string} upstreamRaw
 * @returns {string}
 */
export function diffVectorPayloads(localRaw, upstreamRaw) {
  const local = JSON.stringify(stable(JSON.parse(localRaw)));
  const upstream = JSON.stringify(stable(JSON.parse(upstreamRaw)));
  if (local === upstream) return "";
  return "principal-key-vectors.json differs from mcp_sentinel at the pinned tag.";
}

/**
 * Extra vector names must not collide with the mirror.
 *
 * @param {Array<{name?: string}>} mirror
 * @param {Array<{name?: string}>} extra
 * @returns {string[]}
 */
export function collidingVectorNames(mirror, extra) {
  const names = new Set(mirror.map((row) => row?.name).filter(Boolean));
  return extra.map((row) => row?.name).filter((name) => name && names.has(name));
}

/**
 * @param {string} [tag]
 * @returns {string}
 */
export function upstreamRawUrl(tag = PRINCIPAL_KEY_VECTORS_SENTINEL_TAG) {
  return `https://raw.githubusercontent.com/${SENTINEL_REPO}/${tag}/${PRINCIPAL_KEY_VECTORS_SENTINEL_PATH}`;
}

/**
 * @param {string} [tag]
 * @returns {string}
 */
export function upstreamApiUrl(tag = PRINCIPAL_KEY_VECTORS_SENTINEL_TAG) {
  const api = process.env.GITHUB_API_URL || "https://api.github.com";
  return `${api.replace(/\/+$/, "")}/repos/${SENTINEL_REPO}/contents/${PRINCIPAL_KEY_VECTORS_SENTINEL_PATH}?ref=${encodeURIComponent(tag)}`;
}

/**
 * Fetch the upstream fixture.
 *
 * @param {{fetchFn?: typeof fetch, token?: string, tag?: string}} [options]
 * @returns {Promise<string>}
 */
export async function fetchUpstreamVectors({
  fetchFn = fetch,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  tag = PRINCIPAL_KEY_VECTORS_SENTINEL_TAG,
} = {}) {
  const headers = {
    "user-agent": "drupal-mcp-connector-principal-key-vectors",
    accept: "application/vnd.github.raw",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const api = await fetchFn(upstreamApiUrl(tag), { headers });
  if (api.ok) {
    const body = await api.text();
    JSON.parse(body);
    return body;
  }

  const raw = await fetchFn(upstreamRawUrl(tag), {
    headers: { "user-agent": headers["user-agent"] },
  });
  if (!raw.ok) {
    throw new Error(
      `Could not fetch mcp_sentinel@${tag} ${PRINCIPAL_KEY_VECTORS_SENTINEL_PATH} `
      + `(API ${api.status}, raw ${raw.status}).`,
    );
  }
  return raw.text();
}

/**
 * @param {{root?: string, fetchFn?: typeof fetch, token?: string}} [options]
 * @returns {Promise<{ok: true}|{ok: false, reason: string}>}
 */
export async function checkPrincipalKeyVectors({
  root = REPO_ROOT,
  fetchFn = fetch,
  token,
} = {}) {
  const localPath = join(root, PRINCIPAL_KEY_VECTORS_FILE);
  const extraPath = join(root, PRINCIPAL_KEY_VECTORS_EXTRA_FILE);
  let localRaw;
  let extraRaw;
  try {
    localRaw = readFileSync(localPath, "utf8");
    extraRaw = readFileSync(extraPath, "utf8");
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  let extra;
  try {
    extra = JSON.parse(extraRaw);
  } catch {
    return { ok: false, reason: `${PRINCIPAL_KEY_VECTORS_EXTRA_FILE} is not JSON.` };
  }
  if (!Array.isArray(extra)) {
    return { ok: false, reason: `${PRINCIPAL_KEY_VECTORS_EXTRA_FILE} must be a JSON array.` };
  }
  const mirror = JSON.parse(localRaw);
  const collisions = collidingVectorNames(mirror, extra);
  if (collisions.length) {
    return {
      ok: false,
      reason: `Extra vector names collide with the mirror: ${collisions.join(", ")}.`,
    };
  }
  let upstream;
  try {
    upstream = await fetchUpstreamVectors({ fetchFn, token });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const diff = diffVectorPayloads(localRaw, upstream);
  if (diff) return { ok: false, reason: diff };
  return { ok: true };
}

async function main() {
  const result = await checkPrincipalKeyVectors();
  if (!result.ok) {
    console.error(result.reason);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `principal-key-vectors.json matches mcp_sentinel@${PRINCIPAL_KEY_VECTORS_SENTINEL_TAG}.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
