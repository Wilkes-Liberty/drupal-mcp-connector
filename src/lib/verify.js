/**
 * Secure-install verification (#180).
 *
 * Answers one question with evidence rather than assertion: does THIS
 * connector installation carry the secure, tenant-neutral defaults the
 * governed product claims? The static half needs no network and no
 * credentials — it reads the configuration a clean install ships with, so it
 * runs in CI and in a release proof. The live half (see verifyLive) proves the
 * same claims against a running target.
 *
 * Two rules shape every check:
 *
 *  - A check that cannot run is `skipped`, never `pass`. Silence is not
 *    evidence, and a verifier that reports success for something it never
 *    exercised is worse than no verifier.
 *  - Nothing secret reaches the result. The evidence carries names, hosts and
 *    outcomes — never a token, a secret, or the value of an env var.
 */

import { createHash } from "node:crypto";
import { CLIENT_VERSION } from "./config.js";

/** Check outcome vocabulary. */
export const PASS = "pass";
export const FAIL = "fail";
export const SKIPPED = "skipped";

/** Every static check, in report order. */
export const STATIC_CHECKS = [
  "transport",
  "principal_auth",
  "scope_grant",
  "source_governance",
  "role_separation",
  "entitlement",
  "target_resolution",
  "tenant_neutrality",
];

/**
 * Named residuals: properties this stack manages rather than solves.
 *
 * They are part of the evidence on purpose. A release proof that lists only
 * what passed reads as a claim that nothing else is outstanding.
 */
export const RESIDUALS = [
  {
    id: "prompt_injection",
    status: "managed",
    detail:
      "Prompt injection is not solved by this connector. Instruction-shaped content " +
      "reaching an agent through governed reads can still attempt to redirect it. " +
      "What the stack constrains is the blast radius: least-privilege scopes, per-role " +
      "presets, source-side governance (entity/field denies, egress ceilings, finite " +
      "read budgets), no agent publication authority, and an audit trail of every " +
      "governed action. Treat model output as untrusted input to any subsequent step.",
  },
  {
    id: "operator_trust",
    status: "managed",
    detail:
      "An operator who holds the client secrets can act with the agent's authority. " +
      "Secret custody, rotation and revocation stay the deploying organisation's " +
      "responsibility; the connector reads secrets from the environment and never " +
      "stores them.",
  },
];

/** Hostname suffixes reserved for documentation and testing (RFC 2606/6761). */
const RESERVED_SUFFIXES = [".example.com", ".example.org", ".example.net", ".example", ".test", ".invalid", ".localhost"];

/** Exact hostnames that are reserved, or public project infrastructure. */
const RESERVED_HOSTS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "localhost",
  "127.0.0.1",
  "::1",
  // Public project hosts an example may legitimately name: they identify the
  // Drupal project itself, not the tenant deploying it.
  "www.drupal.org",
  "drupal.org",
]);

/**
 * Whether a hostname is safe to ship in an example: reserved for documentation,
 * loopback, or public project infrastructure.
 * @param {string} host Hostname, without scheme or port.
 * @returns {boolean}
 */
export function isNeutralHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (RESERVED_HOSTS.has(h)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  return RESERVED_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/** Whether a URL points at the loopback interface. */
function isLoopback(url) {
  const host = hostOf(url);
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** The hostname of a URL string, or "" when it cannot be parsed. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Whether a site declares OAuth or the source-governance requirement. */
function isGoverned(site) {
  return site?.requireGovernance === true || Boolean(site?.oauth);
}

/** Whether a site is an explicitly local development target. */
function isLocalDevelopment(site) {
  return isLoopback(site?.baseUrl) && site?.security?.preset === "development";
}

/** Builds one check result. */
function check(id, title, findings, { skipped = false } = {}) {
  const status = skipped ? SKIPPED : findings.length === 0 ? PASS : FAIL;
  return { id, title, status, findings };
}

/**
 * Every string value in a nested structure, with its path.
 * @param {*} value Any JSON-ish value.
 * @param {string[]} path Accumulated key path.
 * @returns {Array<{path: string, value: string}>}
 */
function strings(value, path = []) {
  if (typeof value === "string") return [{ path: path.join("."), value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, String(i)]));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]));
  }
  return [];
}

/**
 * Hostnames mentioned anywhere in a value: URLs, and bare host-shaped strings.
 * @param {*} value Any JSON-ish value.
 * @returns {Array<{path: string, host: string}>}
 */
function mentionedHosts(value) {
  const found = [];
  for (const { path, value: str } of strings(value)) {
    // Documentation prose (the "_comment" keys) is not configuration; it is
    // reviewed, not parsed.
    if (path.split(".").some((segment) => segment.startsWith("_"))) continue;
    const urlHost = hostOf(str);
    if (urlHost) {
      found.push({ path, host: urlHost });
      continue;
    }
    if (/^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i.test(str)) {
      found.push({ path, host: str.toLowerCase() });
    }
  }
  return found;
}

/**
 * A stable digest of the verified configuration, secrets excluded.
 *
 * Ties an evidence document to the exact input that produced it without
 * carrying that input — or any secret in it — into the result.
 * @param {object} config The configuration under verification.
 * @returns {string} `sha256:<hex>`
 */
export function configDigest(config) {
  const redactKeys = new Set(["clientSecret", "apiToken", "secret", "password"]);
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce((out, key) => {
          out[key] = redactKeys.has(key) ? "[REDACTED]" : normalize(value[key]);
          return out;
        }, {});
    }
    return value;
  };
  return "sha256:" + createHash("sha256").update(JSON.stringify(normalize(config))).digest("hex");
}

/**
 * Verify a configuration's secure, tenant-neutral defaults. No network, no
 * credentials, no side effects.
 *
 * @param {object} config Parsed connector configuration.
 * @param {{source?: string, now?: () => Date}} [options]
 *   `source` names what was verified (a path, or a label) for the evidence;
 *   `now` is injectable so a run is reproducible in tests.
 * @returns {object} Evidence document: tool, version, subject, checks,
 *   residuals and a summary. Never contains secret values.
 */
export function verifyStatic(config, { source = "config", now = () => new Date() } = {}) {
  const sites = Object.entries(config?.sites ?? {});
  const named = (name, message) => `${name}: ${message}`;
  const nothingToCheck = sites.length === 0;

  const transport = check(
    "transport",
    "Every site is reached over HTTPS (or an explicit loopback target)",
    sites.flatMap(([name, site]) => {
      const url = String(site?.baseUrl ?? "");
      if (url.startsWith("https://")) return [];
      if (isLoopback(url)) return [];
      return [named(name, `baseUrl is not HTTPS (${url || "missing"}).`)];
    }),
    { skipped: nothingToCheck },
  );

  const principalAuth = check(
    "principal_auth",
    "Every site authenticates as a named principal, with the secret out of the file",
    sites.flatMap(([name, site]) => {
      const findings = [];
      const oauth = site?.oauth;
      if (oauth) {
        if (!oauth.clientId) findings.push(named(name, "OAuth block has no clientId."));
        if (oauth.clientSecret) {
          findings.push(named(name, "OAuth clientSecret is inline; use clientSecretEnv so the secret stays out of the config file."));
        } else if (!oauth.clientSecretEnv) {
          findings.push(named(name, "OAuth block names no clientSecretEnv."));
        }
      } else if (site?.apiToken) {
        findings.push(named(name, "apiToken is inline; use apiTokenEnv so the secret stays out of the config file."));
      } else if (!site?.apiTokenEnv) {
        findings.push(named(name, "no credential configured (neither an oauth block nor apiTokenEnv)."));
      }
      if (isGoverned(site) && site?.requireSecureAuth !== true) {
        findings.push(named(name, "requireSecureAuth is not set on a governed site; anonymous and basic auth would be accepted."));
      }
      return findings;
    }),
    { skipped: nothingToCheck },
  );

  const oauthSites = sites.filter(([, site]) => Boolean(site?.oauth));
  const scopeGrant = check(
    "scope_grant",
    "Every OAuth site names the scopes its token carries (no empty-scope bypass)",
    oauthSites.flatMap(([name, site]) => {
      const scopes = site.oauth.scopes ?? [];
      return Array.isArray(scopes) && scopes.length > 0
        ? []
        : [named(name, "OAuth block names no scopes; an unnamed grant is not a wildcard and every scope gate will now deny.")];
    }),
    { skipped: oauthSites.length === 0 },
  );

  const sourceGovernance = check(
    "source_governance",
    "Governed sites require the source-governance contract",
    sites.flatMap(([name, site]) => {
      if (!isGoverned(site) || isLocalDevelopment(site)) return [];
      return site.requireGovernance === true
        ? []
        : [named(name, "requireGovernance is not set; the connector would fall back to an ungoverned JSON:API or GraphQL path.")];
    }),
    { skipped: nothingToCheck },
  );

  const roleSeparation = check(
    "role_separation",
    "Each role carries its own client id and its own secret",
    (() => {
      const findings = [];
      const byEnv = new Map();
      const byClient = new Map();
      for (const [name, site] of oauthSites) {
        const env = site.oauth.clientSecretEnv;
        const client = site.oauth.clientId;
        if (env) byEnv.set(env, [...(byEnv.get(env) ?? []), name]);
        if (client) byClient.set(client, [...(byClient.get(client) ?? []), name]);
      }
      for (const [env, names] of byEnv) {
        if (names.length > 1) {
          findings.push(`${names.join(", ")}: share the secret env var ${env}; a compromise of one role is a compromise of all of them.`);
        }
      }
      for (const [client, names] of byClient) {
        if (names.length > 1) {
          findings.push(`${names.join(", ")}: share the OAuth client id "${client}"; separate roles need separate principals.`);
        }
      }
      return findings;
    })(),
    { skipped: oauthSites.length === 0 },
  );

  const entitlement = check(
    "entitlement",
    "Every site pins a security preset, and the permissive preset stays local",
    sites.flatMap(([name, site]) => {
      const preset = site?.security?.preset;
      if (!preset) return [named(name, "no security preset configured; the connector's entitlement layer is unpinned.")];
      if (preset === "development" && !isLoopback(site?.baseUrl)) {
        return [named(name, 'the "development" preset allows every operation and is for loopback targets only.')];
      }
      return [];
    }),
    { skipped: nothingToCheck },
  );

  const targetResolution = check(
    "target_resolution",
    "Every site resolves to exactly one target, and the default site exists",
    (() => {
      const findings = [];
      if (nothingToCheck) findings.push("no sites are configured; there is nothing to resolve a tool call to.");
      for (const [name, site] of sites) {
        if (!site?.baseUrl) findings.push(named(name, "no baseUrl; the site cannot be resolved to a target."));
      }
      const def = config?.defaultSite;
      if (def && !Object.prototype.hasOwnProperty.call(config?.sites ?? {}, def)) {
        findings.push(`defaultSite "${def}" names a site that does not exist.`);
      }
      return findings;
    })(),
  );

  const tenantNeutrality = check(
    "tenant_neutrality",
    "The configuration names no real tenant hosts or identifiers",
    mentionedHosts(config?.sites ?? {})
      .filter(({ host }) => !isNeutralHost(host))
      .map(({ path, host }) => `${path}: "${host}" is not a documentation-reserved host; a shipped example must not name a real deployment.`),
    { skipped: nothingToCheck },
  );

  const checks = [
    transport,
    principalAuth,
    scopeGrant,
    sourceGovernance,
    roleSeparation,
    entitlement,
    targetResolution,
    tenantNeutrality,
  ];

  const counts = checks.reduce(
    (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
    { [PASS]: 0, [FAIL]: 0, [SKIPPED]: 0 },
  );

  return {
    tool: "drupal-mcp-connector verify",
    mode: "static",
    connectorVersion: CLIENT_VERSION,
    generatedAt: now().toISOString(),
    subject: {
      source,
      siteCount: sites.length,
      sites: sites.map(([name]) => name),
      configDigest: configDigest(config ?? {}),
    },
    checks,
    residuals: RESIDUALS,
    summary: {
      pass: counts[PASS],
      fail: counts[FAIL],
      skipped: counts[SKIPPED],
      // A skipped check is not a pass: an install is only verified when every
      // check actually ran and none failed.
      ok: counts[FAIL] === 0 && counts[SKIPPED] === 0,
    },
  };
}
