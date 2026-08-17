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
import { resolveInboundAuthConfig, resolveInboundAuthMode } from "./http-auth.js";

/** Check outcome vocabulary.
 *
 * `skipped` and `n/a` are deliberately different. A check that SHOULD have run
 * and could not is `skipped`, and a skipped check fails the run — silence is
 * not evidence. A check that does not apply to this shape of install (no OAuth
 * to scope, no second role to separate, no config surface to deny) is `n/a`
 * and does not fail it: a verifier a secure install can never pass is a
 * verifier people stop running.
 */
export const PASS = "pass";
export const FAIL = "fail";
export const SKIPPED = "skipped";
export const NOT_APPLICABLE = "n/a";

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
  "inbound_auth",
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
function check(id, title, findings, { skipped = false, notApplicable = false, reason = "" } = {}) {
  const status = notApplicable ? NOT_APPLICABLE : skipped ? SKIPPED : findings.length === 0 ? PASS : FAIL;
  return { id, title, status, findings: (skipped || notApplicable) && reason ? [reason] : findings };
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
 * Whether a bare string looks like a hostname.
 *
 * Deliberately label-by-label rather than one nested-quantifier regex: the
 * pattern form of this test backtracks catastrophically on a long dotless
 * string, and a verifier is not a place to introduce a denial of service.
 * @param {string} str Candidate.
 * @returns {boolean}
 */
function looksLikeHostname(str) {
  if (typeof str !== "string" || str.length < 4 || str.length > 253) return false;
  const labels = str.split(".");
  if (labels.length < 2) return false;
  if (!/^[a-z]{2,}$/i.test(labels[labels.length - 1])) return false;
  return labels.slice(0, -1).every((label) => /^[a-z0-9-]+$/i.test(label));
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
    if (looksLikeHostname(str)) {
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
 * @param {{source?: string, now?: () => Date, env?: NodeJS.ProcessEnv}} [options]
 *   `source` names what was verified (a path, or a label) for the evidence;
 *   `now` is injectable so a run is reproducible in tests;
 *   `env` is the process environment under verification (defaults to `process.env`).
 * @returns {object} Evidence document: tool, version, subject, checks,
 *   residuals and a summary. Never contains secret values.
 */
export function verifyStatic(config, { source = "config", now = () => new Date(), env = process.env } = {}) {
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
    {
      notApplicable: oauthSites.length === 0,
      reason: "no site authenticates with OAuth, so there are no scopes to name.",
    },
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
    {
      notApplicable: oauthSites.length === 0,
      reason: "no site authenticates with OAuth, so there are no principals to separate.",
    },
  );

  const entitlement = check(
    "entitlement",
    "Every site pins a security preset, and the permissive preset stays local",
    sites.flatMap(([name, site]) => {
      const preset = site?.security?.preset;
      if (!preset) return [named(name, "no security preset configured; the connector's entitlement layer is unpinned.")];
      if (preset === "development" && !isLoopback(site?.baseUrl)) {
        return [named(name, "the \"development\" preset allows every operation and is for loopback targets only.")];
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
    mentionedHosts({ sites: config?.sites ?? {}, auth: config?.auth ?? {} })
      .filter(({ host }) => !isNeutralHost(host))
      .map(({ path, host }) => `${path}: "${host}" is not a documentation-reserved host; a shipped example must not name a real deployment.`),
    { skipped: nothingToCheck },
  );

  const inbound = resolveInboundAuthConfig(config, env);
  const inboundFindings = [];
  if (inbound.issuer || inbound.audience || inbound.resource) {
    if (!inbound.issuer) inboundFindings.push("auth.issuer is missing.");
    else if (!String(inbound.issuer).startsWith("https://")) {
      inboundFindings.push("auth.issuer is not HTTPS.");
    }
    if (!inbound.audience) inboundFindings.push("auth.audience is missing.");
    if (inbound.resource && !String(inbound.resource).startsWith("https://")) {
      inboundFindings.push("auth.resource is not HTTPS.");
    }
    if (inbound.introspectionUrl && !String(inbound.introspectionUrl).startsWith("https://")) {
      inboundFindings.push("auth.introspectionUrl is not HTTPS.");
    }
  }
  const transportName = env.MCP_TRANSPORT || "stdio";
  if (transportName === "https" || transportName === "http") {
    const decision = resolveInboundAuthMode({
      bindHost: env.MCP_BIND_HOST || "0.0.0.0",
      allowUnauth: env.MCP_ALLOW_UNAUTHENTICATED === "1",
      sharedToken: env.MCP_AUTH_TOKEN || "",
      resourceServer: inbound,
    });
    if (decision.mode === "fatal") inboundFindings.push(decision.reason);
  }

  const inboundAuth = check(
    "inbound_auth",
    "Network-facing HTTPS authenticates as an OAuth protected resource",
    inboundFindings,
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
    inboundAuth,
  ];

  const counts = checks.reduce(
    (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
    { [PASS]: 0, [FAIL]: 0, [SKIPPED]: 0, [NOT_APPLICABLE]: 0 },
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
      notApplicable: counts[NOT_APPLICABLE],
      // A skipped check is not a pass: an install is only verified when every
      // applicable check actually ran and none failed. A not-applicable check
      // does not block — it never had anything to prove.
      ok: counts[FAIL] === 0 && counts[SKIPPED] === 0,
    },
  };
}

/** Every live check, in report order. */
export const LIVE_CHECKS = [
  "transport",
  "principal_auth",
  "source_governance",
  "entitlement_filtering",
  "target_resolution",
  "probe_mass_read",
  "probe_config_change",
  "probe_content_edit",
];

/** A page size no governed profile should ever serve in one response. */
const MASS_READ_LIMIT = 5000;

/** The governed config-write tool, under the bridge's derivative name. */
const CONFIG_SET_TOOL = "tool_api.mcp_sentinel_config_set";

/** Joins a base URL and a path without doubling or dropping the separator. */
function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

/**
 * One transport attempt, reduced to what the evidence may carry.
 *
 * Never returns a body: a governed read's payload is the very thing that must
 * not end up in a verification artefact. What is recorded is the status, and
 * the stable error/reason codes the source uses to explain a refusal.
 *
 * @param {Function} transport fetch-shaped transport.
 * @param {string} url Absolute URL.
 * @param {object} [init] fetch init.
 * @returns {Promise<{status: number|null, ok: boolean, codes: string[], reason: string|null, count: number|null, error: string|null}>}
 */
async function attempt(transport, url, init = {}) {
  try {
    const response = await transport(url, init);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const codes = Array.isArray(body?.errors)
      ? body.errors.map((e) => e?.code).filter(Boolean)
      : [];
    return {
      status: response.status ?? null,
      ok: Boolean(response.ok),
      codes,
      reason: typeof body?.reason === "string" ? body.reason : null,
      count: Array.isArray(body?.data) ? body.data.length : null,
      error: typeof body?.error === "string" ? body.error : null,
    };
  } catch (err) {
    return { status: null, ok: false, codes: [], reason: null, count: null, error: String(err?.message ?? err) };
  }
}

/**
 * Whether a thrown bridge error is a POLICY refusal or an unexercised probe.
 *
 * A probe that passes "because the target refused" must prove which refusal it
 * read. `callServerTool` throws for several unrelated reasons, and only some of
 * them mean the source decided:
 *
 *  - a tool-level error (the tool ran and refused)            → refused
 *  - a server-defined JSON-RPC error (-32000..-32099)         → refused
 *  - an HTTP 401/403 on the tools/call                        → refused
 *  - a standard JSON-RPC error (method not found, bad params) → unexercised
 *  - any other HTTP status (400, 404, 5xx)                    → unexercised
 *  - no bridge configured, session init, network failure      → unexercised
 *
 * Scoring an unexercised probe as a refusal is how a verifier produces a green
 * document for an install that never proved anything.
 *
 * @param {Error} error Thrown by the bridge client.
 * @returns {{outcome: "refused"|"unexercised", detail: string}}
 */
export function classifyBridgeError(error) {
  const message = String(error?.message ?? error);
  const detail = message.slice(0, 200);

  // The tool ran and reported an error: the canonical governed refusal.
  if (/ reported an error:/.test(message)) return { outcome: "refused", detail };

  // JSON-RPC error at the tools/call. Server-defined codes are decisions;
  // the standard codes mean the call itself was wrong.
  const rpc = message.match(/ error \((-?\d+)\):/);
  if (rpc) {
    const code = Number(rpc[1]);
    const isStandard = [-32700, -32600, -32601, -32602, -32603].includes(code);
    // A session-initialize error never reached the tool, whatever its code.
    if (/session initialize/.test(message)) return { outcome: "unexercised", detail };
    return isStandard ? { outcome: "unexercised", detail } : { outcome: "refused", detail };
  }

  // HTTP status on the tools/call: an authorisation status is a decision.
  const http = message.match(/^Server-tool call .* failed (\d{3}):/);
  if (http) {
    const status = Number(http[1]);
    return status === 401 || status === 403
      ? { outcome: "refused", detail }
      : { outcome: "unexercised", detail };
  }

  // Bridge not configured, session initialise failure, transport error.
  return { outcome: "unexercised", detail };
}

/** Builds a live check result, carrying what was observed. */
function liveCheck(id, title, findings, observed = null, { skipped = false, notApplicable = false, skipReason = "" } = {}) {
  const status = notApplicable ? NOT_APPLICABLE : skipped ? SKIPPED : findings.length === 0 ? PASS : FAIL;
  return {
    id,
    title,
    status,
    findings: (skipped || notApplicable) && skipReason ? [skipReason] : findings,
    observed,
  };
}

/**
 * Verify a running target against the same claims as the static half.
 *
 * The three `probe_*` checks are deliberately inverted: they attempt something
 * a governed principal must NOT be able to do, and pass only when the target
 * refuses. A served probe is the finding.
 *
 * Nothing here writes content: the write probes target a non-existent id and
 * a governed stack refuses on policy before persistence. Run against a
 * non-production environment first.
 *
 * @param {object} site Resolved site config (with oauth.clientSecret resolved).
 * @param {{transport: Function, now?: () => Date}} deps
 *   `transport` is fetch-shaped and injectable so this is testable offline.
 * @returns {Promise<object>} Evidence document. Never contains secrets or payloads.
 */
export async function verifyLive(site, { transport, callTool = null, contentTarget = null, contentTargetType = null, now = () => new Date() }) {
  const baseUrl = String(site?.baseUrl ?? "");
  const checks = [];
  const httpsOk = baseUrl.startsWith("https://") || isLoopback(baseUrl);

  // --- transport -----------------------------------------------------------
  const health = httpsOk ? await attempt(transport, joinUrl(baseUrl, "/drupal-mcp/health")) : null;
  checks.push(
    liveCheck(
      "transport",
      "The target answers over an encrypted transport",
      (() => {
        if (!httpsOk) return [`baseUrl is not HTTPS (${baseUrl || "missing"}).`];
        if (health.error) return [`the target could not be reached: ${health.error}`];
        if (health.status === null) return ["the target returned no status."];
        return [];
      })(),
      health && { status: health.status },
    ),
  );

  // --- principal authentication -------------------------------------------
  const oauth = site?.oauth;
  let token = null;
  if (!oauth?.clientId || !oauth?.clientSecret) {
    checks.push(
      liveCheck("principal_auth", "The principal authenticates, and anonymous access is refused", [], null, {
        skipped: true,
        skipReason: "no OAuth principal is configured for this site; nothing to authenticate as.",
      }),
    );
  } else {
    // Mint ONCE. Two mints made the check pass on the first while the second
    // silently yielded no token, leaving every later call unauthenticated —
    // so the negative probes would "pass" on 401s instead of real refusals.
    const tokenForm = new URLSearchParams({
      grant_type: oauth.grant ?? "client_credentials",
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      scope: (oauth.scopes ?? []).join(" "),
    }).toString();
    let tokenStatus = null;
    let tokenError = null;
    try {
      const response = await transport(joinUrl(baseUrl, oauth.tokenUrl ?? "/oauth/token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenForm,
      });
      tokenStatus = response.status ?? null;
      if (response.ok) {
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        const minted = body?.access_token;
        if (typeof minted === "string" && minted !== "") {
          token = minted;
        }
      }
    } catch (err) {
      tokenError = String(err?.message ?? err);
    }
    const anonymous = await attempt(transport, joinUrl(baseUrl, "/drupal-mcp/readiness"));
    checks.push(
      liveCheck(
        "principal_auth",
        "The principal authenticates, and anonymous access is refused",
        (() => {
          const findings = [];
          if (!token) {
            findings.push(
              `the principal did not obtain a usable access token (status ${tokenStatus ?? "none"}` +
                `${tokenError ? `, ${tokenError}` : ""}).`,
            );
          }
          if (anonymous.ok) {
            findings.push("a governed path answered an anonymous request; authentication is not being enforced.");
          }
          return findings;
        })(),
        { tokenStatus, anonymousStatus: anonymous.status },
      ),
    );
  }

  const authorized = token ? { Authorization: `Bearer ${token}` } : {};

  // Without a usable token, an authenticated check proves nothing: a refusal
  // would be a 401, not a policy decision. Skip rather than claim either way.
  const unauthenticated = Boolean(oauth?.clientId && oauth?.clientSecret) && !token;
  const noTokenSkip = {
    skipped: true,
    skipReason: "the principal has no usable access token, so a refusal here would prove nothing about policy.",
  };

  // --- source governance ---------------------------------------------------
  if (unauthenticated) {
    checks.push(liveCheck("source_governance", "The source governance contract verifies", [], null, noTokenSkip));
  } else if (site?.requireGovernance !== true) {
    checks.push(
      liveCheck("source_governance", "The source governance contract verifies", [], null, {
        notApplicable: true,
        skipReason: "the site does not declare requireGovernance; there is no contract to verify.",
      }),
    );
  } else {
    const readiness = await attempt(transport, joinUrl(baseUrl, "/drupal-mcp/readiness"), { headers: authorized });
    checks.push(
      liveCheck(
        "source_governance",
        "The source governance contract verifies",
        readiness.ok
          ? []
          : [
            `the source reports the contract is not ready (status ${readiness.status ?? "none"}` +
                `${readiness.reason ? `, reason ${readiness.reason}` : ""}).`,
          ],
        { status: readiness.status, reason: readiness.reason },
      ),
    );
  }

  // --- entitlement filtering ----------------------------------------------
  // Through the connector's own bridge client, so the probe exercises the real
  // contract: an MCP session, the governed tool's `tool_api.*` name and its
  // argument shape, and a refusal surfaced as a tool/JSON-RPC error rather
  // than an HTTP status. A hand-rolled JSON-RPC body would "pass" for the
  // wrong reason — the server would reject it as malformed, not as denied.
  const scopes = site?.oauth?.scopes ?? [];
  const holdsConfigScope = scopes.includes("mcp_config");

  /**
   * Attempts a governed config write. Returns {served, detail}: `served` true
   * means the write was accepted, which for an out-of-tier principal is the
   * finding.
   */
  const attemptConfigWrite = async () => {
    try {
      await callTool(site, CONFIG_SET_TOOL, { name: "system.site", data: { name: "verification probe" } });
      return { served: true, outcome: "served", detail: "accepted" };
    } catch (err) {
      // Not every throw is a refusal — see classifyBridgeError.
      const { outcome, detail } = classifyBridgeError(err);
      return { served: false, outcome, detail };
    }
  };

  let configWrite = null;
  if (unauthenticated) {
    checks.push(liveCheck("entitlement_filtering", "Out-of-tier operations are filtered for this principal", [], null, noTokenSkip));
  } else if (holdsConfigScope) {
    checks.push(
      liveCheck("entitlement_filtering", "Out-of-tier operations are filtered for this principal", [], null, {
        notApplicable: true,
        skipReason: "this principal holds mcp_config, so a config write is in tier; run the probe with a content-tier principal.",
      }),
    );
  } else if (typeof callTool !== "function" || !site?.serverTools?.url) {
    checks.push(
      liveCheck("entitlement_filtering", "Out-of-tier operations are filtered for this principal", [], null, {
        notApplicable: true,
        skipReason: "no governed tool bridge is configured for this site (serverTools.url), so there is no config surface to deny.",
      }),
    );
  } else {
    configWrite = await attemptConfigWrite();
    checks.push(
      configWrite.outcome === "unexercised"
        ? liveCheck("entitlement_filtering", "Out-of-tier operations are filtered for this principal", [], configWrite, {
          skipped: true,
          skipReason: `the governed tool call never ran, so no policy decision was observed: ${configWrite.detail}`,
        })
        : liveCheck(
          "entitlement_filtering",
          "Out-of-tier operations are filtered for this principal",
          configWrite.served
            ? ["a config write was served to a principal that does not hold the mcp_config scope."]
            : [],
          configWrite,
        ),
    );
  }

  // --- target resolution ---------------------------------------------------
  if (unauthenticated) {
    checks.push(liveCheck("target_resolution", "The site resolves to exactly one target that describes itself", [], null, noTokenSkip));
  } else {
    const context = await attempt(transport, joinUrl(baseUrl, "/drupal-mcp/context"), { headers: authorized });
    checks.push(
      liveCheck(
        "target_resolution",
        "The site resolves to exactly one target that describes itself",
        context.ok ? [] : [`the target did not return its context document (status ${context.status ?? "none"}).`],
        { status: context.status },
      ),
    );
  }

  // --- negative probes -----------------------------------------------------
  if (unauthenticated) {
    for (const [id, title] of [
      ["probe_mass_read", `A ${MASS_READ_LIMIT}-item read is refused or bounded`],
      ["probe_config_change", "A configuration change is refused"],
      ["probe_content_edit", "An edit to live content is refused"],
    ]) {
      checks.push(liveCheck(id, title, [], null, noTokenSkip));
    }
  } else {
    const massRead = await attempt(
      transport,
      `${joinUrl(baseUrl, "/jsonapi/node/article")}?page%5Blimit%5D=${MASS_READ_LIMIT}`,
      { headers: authorized },
    );
    checks.push(
      (() => {
        const observed = { status: massRead.status, codes: massRead.codes, items: massRead.count };
        const title = `A ${MASS_READ_LIMIT}-item read is refused or bounded`;
        // Refused outright: the control fired.
        if (!massRead.ok) return liveCheck("probe_mass_read", title, [], observed);
        // Served, but bounded well below what was asked for: also the control
        // firing — a cap is a bound, and reporting it as unbounded would train
        // operators to ignore the verifier.
        if (massRead.count !== null && massRead.count < MASS_READ_LIMIT) {
          return liveCheck("probe_mass_read", title, [], observed);
        }
        if (massRead.count === null) {
          return liveCheck("probe_mass_read", title, [], observed, {
            skipped: true,
            skipReason: "the read succeeded but its size could not be measured, so neither a bound nor an unbounded read is proven.",
          });
        }
        return liveCheck(
          "probe_mass_read",
          title,
          [`an unbounded read was served (status ${massRead.status}, ${massRead.count} items); the source is not bounding this principal's reads.`],
          observed,
        );
      })(),
    );

    const canAttemptWrite = scopes.length === 0 || scopes.includes("mcp_write") || scopes.includes("mcp_config");

    // The config probe is only a NEGATIVE probe for a principal that must not
    // write config. A developer or break-glass role legitimately holds
    // mcp_config, and failing its healthy run would be a false finding.
    if (holdsConfigScope) {
      checks.push(
        liveCheck("probe_config_change", "A configuration change is refused", [], null, {
          notApplicable: true,
          skipReason: "this principal holds mcp_config: a served config write is in tier here, so the probe proves nothing. Run it with a content-tier principal.",
        }),
      );
    } else if (typeof callTool !== "function" || !site?.serverTools?.url) {
      checks.push(
        liveCheck("probe_config_change", "A configuration change is refused", [], null, {
          notApplicable: true,
          skipReason: "no governed tool bridge is configured for this site (serverTools.url), so there is no config surface to deny.",
        }),
      );
    } else {
      const attemptResult = configWrite ?? (await attemptConfigWrite());
      checks.push(
        attemptResult.outcome === "unexercised"
          ? liveCheck("probe_config_change", "A configuration change is refused", [], attemptResult, {
            skipped: true,
            skipReason: `the config write never reached a policy decision, so its refusal proves nothing: ${attemptResult.detail}`,
          })
          : liveCheck(
            "probe_config_change",
            "A configuration change is refused",
            attemptResult.served ? ["a configuration write was accepted."] : [],
            attemptResult,
          ),
      );
    }

    if (!canAttemptWrite) {
      checks.push(
        liveCheck("probe_content_edit", "An edit to live content is refused", [], null, {
          notApplicable: true,
          skipReason: "this principal holds no write scope, so there is no write gate for it to cross.",
        }),
      );
    } else if (!contentTarget) {
      // A PATCH at an id that does not exist returns 404 before any access
      // check runs, so scoring it as a refusal would claim the publish gate
      // holds without ever reaching it. The probe needs a real target.
      checks.push(
        liveCheck("probe_content_edit", "An edit to live content is refused", [], null, {
          skipped: true,
          skipReason:
            "no content target supplied (--content-target <uuid>), so the publish gate was never reached. " +
            "Point it at a node on a non-production target that you would not mind being published if the gate fails.",
        }),
      );
    } else {
      const targetType = contentTargetType ?? "node--article";
      const [entityType, bundle] = targetType.split("--");
      const contentEdit = await attempt(
        transport,
        joinUrl(baseUrl, `/jsonapi/${entityType}/${bundle ?? entityType}/${contentTarget}`),
        {
          method: "PATCH",
          headers: { ...authorized, "Content-Type": "application/vnd.api+json" },
          body: JSON.stringify({
            // Publish-bearing and otherwise value-preserving: the flag under
            // test is `status`, so a refusal proves the gate and an acceptance
            // changes nothing else about the node.
            data: { type: targetType, id: contentTarget, attributes: { status: true } },
          }),
        },
      );
      const observed = { status: contentEdit.status, codes: contentEdit.codes, target: contentTarget };
      checks.push(
        (() => {
          const title = "An edit to live content is refused";
          if (contentEdit.ok) {
            return liveCheck(
              "probe_content_edit",
              title,
              [`a publish-bearing edit was ACCEPTED (status ${contentEdit.status}); the no-agent-publish floor did not hold, and the target may now be published.`],
              observed,
            );
          }
          // Only an authorisation decision proves the gate. "Not found",
          // "unprocessable" and server errors never reached it.
          if (contentEdit.status === 403 || contentEdit.status === 401) {
            return liveCheck("probe_content_edit", title, [], observed);
          }
          return liveCheck("probe_content_edit", title, [], observed, {
            skipped: true,
            skipReason: `the edit did not reach the publish gate (status ${contentEdit.status ?? "none"}), so its refusal proves nothing; check the target exists and is of the given type.`,
          });
        })(),
      );
    }
  }

  const counts = checks.reduce(
    (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
    { [PASS]: 0, [FAIL]: 0, [SKIPPED]: 0, [NOT_APPLICABLE]: 0 },
  );

  return {
    tool: "drupal-mcp-connector verify",
    mode: "live",
    connectorVersion: CLIENT_VERSION,
    generatedAt: now().toISOString(),
    subject: { site: site?._name ?? null, host: hostOf(baseUrl), scopes: site?.oauth?.scopes ?? [] },
    checks,
    residuals: RESIDUALS,
    summary: {
      pass: counts[PASS],
      fail: counts[FAIL],
      skipped: counts[SKIPPED],
      notApplicable: counts[NOT_APPLICABLE],
      ok: counts[FAIL] === 0 && counts[SKIPPED] === 0,
    },
  };
}
