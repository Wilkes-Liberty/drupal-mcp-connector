/**
 * Staging pack mode (DEV-866 increment 3).
 *
 * The same deny / allow twins run against a real staging endpoint
 * (Sentinel + Paladin) when the operator sets a base URL and issuer.
 * Read-only: the harness refuses write tool names. Tokens come from the
 * environment; nothing secret is committed. When the endpoint is not
 * configured the pack exits 0 with a skip reason.
 */

const WRITE_TOOL = /(?:^|")drupal_(?:create_|update_|delete_|bulk_|upload_|set_|block_|schedule_|revert_)/;

/** Environment keys the operator sets. No defaults; no secrets in the repo. */
export const STAGING_ENV = Object.freeze({
  baseUrl: "EVAL_HTTP_STAGING_BASE_URL",
  issuer: "EVAL_HTTP_STAGING_ISSUER",
  audience: "EVAL_HTTP_STAGING_AUDIENCE",
  tokenRead: "EVAL_HTTP_STAGING_TOKEN_READ",
  tokenWrongAudience: "EVAL_HTTP_STAGING_TOKEN_WRONG_AUDIENCE",
  tokenExpired: "EVAL_HTTP_STAGING_TOKEN_EXPIRED",
  tokenInsufficientScope: "EVAL_HTTP_STAGING_TOKEN_INSUFFICIENT_SCOPE",
  tokenNonMember: "EVAL_HTTP_STAGING_TOKEN_NON_MEMBER",
});

export const STAGING_SKIP_REASON =
  "staging not configured (set EVAL_HTTP_STAGING_BASE_URL and EVAL_HTTP_STAGING_ISSUER); skipped";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   baseUrl: string,
 *   issuer: string,
 *   audience: string,
 *   tokens: {
 *     read: string,
 *     wrongAudience: string,
 *     expired: string,
 *     insufficientScope: string,
 *     nonMember: string,
 *   },
 * }|null}
 */
export function readStagingConfig(env = process.env) {
  const baseUrl = String(env[STAGING_ENV.baseUrl] || "").trim().replace(/\/+$/, "");
  const issuer = String(env[STAGING_ENV.issuer] || "").trim();
  if (!baseUrl || !issuer) return null;
  return {
    baseUrl,
    issuer,
    audience: String(env[STAGING_ENV.audience] || "").trim(),
    tokens: {
      read: String(env[STAGING_ENV.tokenRead] || "").trim(),
      wrongAudience: String(env[STAGING_ENV.tokenWrongAudience] || "").trim(),
      expired: String(env[STAGING_ENV.tokenExpired] || "").trim(),
      insufficientScope: String(env[STAGING_ENV.tokenInsufficientScope] || "").trim(),
      nonMember: String(env[STAGING_ENV.tokenNonMember] || "").trim(),
    },
  };
}

/**
 * Token env keys required once staging is configured.
 *
 * @param {ReturnType<typeof readStagingConfig>} config
 * @returns {string[]}
 */
export function missingStagingTokens(config) {
  if (!config) return [];
  return Object.entries({
    [STAGING_ENV.tokenRead]: config.tokens.read,
    [STAGING_ENV.tokenWrongAudience]: config.tokens.wrongAudience,
    [STAGING_ENV.tokenExpired]: config.tokens.expired,
    [STAGING_ENV.tokenInsufficientScope]: config.tokens.insufficientScope,
    [STAGING_ENV.tokenNonMember]: config.tokens.nonMember,
  }).filter(([, value]) => !value).map(([key]) => key);
}

/**
 * Refuse a write-shaped tools/call so staging stays read-only.
 *
 * @param {{headers?: object, body?: string}} request
 */
export function assertStagingReadOnly(request) {
  const name = request?.headers?.["mcp-name"];
  const body = typeof request?.body === "string" ? request.body : "";
  if ((typeof name === "string" && WRITE_TOOL.test(name)) || WRITE_TOOL.test(body)) {
    throw new Error("staging pack is read-only; refused a write tool call");
  }
}

/**
 * Remote harness: HTTP-observable only. No dispatch counters, no fakes.
 *
 * @param {ReturnType<typeof readStagingConfig>} [config]
 * @returns {Promise<object>}
 */
export async function buildStagingHarness(config = readStagingConfig()) {
  if (!config) {
    throw new Error(STAGING_SKIP_REASON);
  }
  const origin = config.baseUrl.replace(/\/mcp$/, "");
  const tap = { responses: [], record(entry) { tap.responses.push(entry); } };
  const harness = {
    remote: true,
    mutant: null,
    configDigest: "staging",
    url: `${origin}/mcp`,
    origin,
    resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    counters: { ch: 0, ct: 0 },
    tap,
    auditRows: [],
    fake: { count: () => 0, canaries: {} },
    assertions: 0,
    tokens: config.tokens,
    issuer: {
      mint: async () => {
        throw new Error("staging pack does not mint tokens; use EVAL_HTTP_STAGING_TOKEN_*");
      },
    },
    tokenFor: async () => config.tokens.read,
    /**
     * @param {{method: string, headers: object, body?: string, path?: string}} request
     * @param {{token?: string, headers?: object, path?: string}} [options]
     */
    async send(request, { token, headers: extra = {}, path } = {}) {
      assertStagingReadOnly(request);
      const route = path || request.path || "/mcp";
      const headers = { ...request.headers, ...extra };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${origin}${route}`, {
        method: request.method,
        headers,
        body: request.body,
      });
      const entry = {
        status: res.status,
        headers: Object.fromEntries(res.headers),
        text: await res.text(),
        route,
      };
      tap.record(entry);
      return entry;
    },
    dispatchCounts: () => ({ ch: 0, ct: 0, cu: 0 }),
    waitServerSide: async () => {},
    close: async () => {},
  };
  return harness;
}
