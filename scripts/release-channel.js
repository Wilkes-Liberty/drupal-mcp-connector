#!/usr/bin/env node
/**
 * release-channel.js — map a semver version (or `v*` tag) to release channels.
 *
 * DEV-841: a prerelease (`-rc`, `-pre`, any semver prerelease) publishes to the
 * npm `next` dist-tag, is a GitHub prerelease, and must not move GHCR
 * `:latest` / `:X` / `:X.Y`. A final `X.Y.Z` takes npm `latest`.
 *
 * Exports `resolveReleaseChannel` and `assertImageTags` for tests. CLI writes
 * GitHub Actions outputs when `--github-output` is set. Side effects run only
 * when executed directly.
 */

import { appendFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Semver core + optional prerelease + optional build metadata. */
const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Classify a version string or `v*` tag.
 *
 * @param {string} input Version (`5.1.0-rc.1`) or tag (`v5.1.0-rc.1`).
 * @param {{ allowFloating?: boolean }} [options] `allowFloating` is the
 *   tag-push path. Backfills and non-semver refs never get floating tags,
 *   even for a final `X.Y.Z`.
 * @returns {{
 *   version: string,
 *   isSemver: boolean,
 *   isPrerelease: boolean,
 *   npmDistTag: "latest" | "next",
 *   githubPrerelease: boolean,
 *   floatingTags: boolean,
 *   major: string,
 *   minor: string,
 *   patch: string,
 *   semverValue: string,
 * }}
 */
export function resolveReleaseChannel(input, options = {}) {
  const allowFloating = options.allowFloating === true;
  const version = String(input ?? "").trim().replace(/^v/i, "");
  const match = version.match(SEMVER);
  if (!match) {
    return {
      version,
      isSemver: false,
      isPrerelease: false,
      npmDistTag: "latest",
      githubPrerelease: false,
      floatingTags: false,
      major: "",
      minor: "",
      patch: "",
      semverValue: "",
    };
  }
  const isPrerelease = Boolean(match[4]);
  return {
    version,
    isSemver: true,
    isPrerelease,
    npmDistTag: isPrerelease ? "next" : "latest",
    githubPrerelease: isPrerelease,
    floatingTags: allowFloating && !isPrerelease,
    major: match[1],
    minor: match[2],
    patch: match[3],
    semverValue: `v${version}`,
  };
}

/**
 * Fail if a metadata-action tag list violates the channel rules.
 *
 * @param {string} tagList Newline- or comma-separated image refs.
 * @param {ReturnType<typeof resolveReleaseChannel>} channel
 */
export function assertImageTags(tagList, channel) {
  const tags = String(tagList)
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
  const suffixes = tags.map((ref) => {
    const colon = ref.lastIndexOf(":");
    return colon >= 0 ? ref.slice(colon + 1) : ref;
  });
  const have = new Set(suffixes);
  const missing = [];
  for (const suffix of [channel.version, `v${channel.version}`]) {
    if (channel.version && !have.has(suffix)) missing.push(`:${suffix}`);
  }
  if (missing.length) {
    throw new Error(`image tags missing ${missing.join(", ")} (got ${suffixes.join(", ") || "(none)"})`);
  }
  if (!channel.floatingTags) {
    const forbidden = ["latest"];
    if (channel.major) forbidden.push(channel.major);
    if (channel.major && channel.minor) forbidden.push(`${channel.major}.${channel.minor}`);
    const taken = forbidden.filter((suffix) => have.has(suffix));
    if (taken.length) {
      throw new Error(
        `prerelease/non-floating image must not take :${taken.join(", :")} (got ${suffixes.join(", ")})`,
      );
    }
    return;
  }
  const required = ["latest", channel.major, `${channel.major}.${channel.minor}`];
  const absent = required.filter((suffix) => suffix && !have.has(suffix));
  if (absent.length) {
    throw new Error(`final image must take :${absent.join(", :")} (got ${suffixes.join(", ")})`);
  }
}

/**
 * @param {ReturnType<typeof resolveReleaseChannel>} channel
 * @returns {string}
 */
function formatGitHubOutput(channel) {
  return [
    `version=${channel.version}`,
    `is_semver=${channel.isSemver}`,
    `is_prerelease=${channel.isPrerelease}`,
    `npm_dist_tag=${channel.npmDistTag}`,
    `github_prerelease=${channel.githubPrerelease}`,
    `floating_tags=${channel.floatingTags}`,
    `major=${channel.major}`,
    `minor=${channel.minor}`,
    `semver_value=${channel.semverValue}`,
  ].join("\n");
}

/**
 * @param {string[]} argv
 * @returns {{
 *   version: string,
 *   allowFloating: boolean,
 *   githubOutput: boolean,
 *   expectNpmTag: string,
 *   assertImageTags: boolean,
 *   tags: string,
 * }}
 */
export function parseArgs(argv) {
  const out = {
    version: "",
    allowFloating: false,
    githubOutput: false,
    expectNpmTag: "",
    assertImageTags: false,
    tags: "",
  };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--version") out.version = args.shift() ?? "";
    else if (arg === "--allow-floating") out.allowFloating = true;
    else if (arg === "--github-output") out.githubOutput = true;
    else if (arg === "--expect-npm-tag") out.expectNpmTag = args.shift() ?? "";
    else if (arg === "--assert-image-tags") out.assertImageTags = true;
    else if (arg === "--tags") out.tags = args.shift() ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: { write: (s: string) => void }, env?: NodeJS.ProcessEnv }} [io]
 * @returns {ReturnType<typeof resolveReleaseChannel>}
 */
export function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const env = io.env ?? process.env;
  const args = parseArgs(argv);
  if (!args.version) throw new Error("--version is required");
  const channel = resolveReleaseChannel(args.version, {
    allowFloating: args.allowFloating,
  });
  if (args.expectNpmTag && channel.npmDistTag !== args.expectNpmTag) {
    throw new Error(
      `${channel.version} must publish to npm dist-tag ${args.expectNpmTag}, got ${channel.npmDistTag}`,
    );
  }
  if (args.assertImageTags) {
    assertImageTags(args.tags, channel);
  }
  if (args.githubOutput) {
    const dest = env.GITHUB_OUTPUT;
    const body = `${formatGitHubOutput(channel)}\n`;
    if (dest) appendFileSync(dest, body);
    else stdout.write(body);
  } else {
    stdout.write(`${JSON.stringify(channel, null, 2)}\n`);
  }
  return channel;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
