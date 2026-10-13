/**
 * Minimal, dependency-free fixed-window rate limiter for the HTTPS transport.
 *
 * Opt-in: with a falsy/non-positive `limit` it's a no-op (always allows).
 * Counts are in-memory per process. Keys are caller-chosen: standalone `/mcp`
 * uses an address key for unauthenticated requests and a verified-principal
 * key (`sub` + `clientId` from the validated token) after auth (DEV-860).
 * The map is hard-capped (`maxKeys`) so spraying principals or addresses
 * cannot grow limiter state without bound. Multi-replica deployments still
 * need a shared limiter at the reverse proxy — this process cannot see
 * sibling replicas.
 */

/** Non-loopback TLS default when `MCP_RATE_LIMIT` is unset (#141, DEV-860). */
export const DEFAULT_HTTPS_RATE_LIMIT = 120;

/** Default window for `MCP_RATE_WINDOW_SEC`. */
export const DEFAULT_RATE_WINDOW_SEC = 60;

/** Hard cap on tracked keys (DEV-860). */
export const DEFAULT_RATE_MAX_KEYS = 10_000;

/**
 * @typedef {object} RateVerdict
 * @property {boolean} allowed     Whether the request may proceed.
 * @property {number}  remaining   Requests left in the current window (Infinity when disabled).
 * @property {number}  retryAfterSec Seconds until the window resets (0 when allowed).
 */

/**
 * Create a fixed-window rate limiter.
 * @param {object} opts
 * @param {?number} opts.limit       Max requests per window per key. Falsy/<=0 disables limiting.
 * @param {number}  [opts.windowMs]  Window length in ms (default 60_000).
 * @param {() => number} [opts.now]  Clock (injectable for tests; default Date.now).
 * @param {number}  [opts.maxKeys]   Hard cap on tracked keys (default 10_000). Expired
 *   buckets are pruned first; if the map is still full, the oldest insertion
 *   is evicted so spray cannot exhaust memory.
 * @returns {{ check: (key: string) => RateVerdict, peek: (key: string) => RateVerdict, size: () => number }}
 */
export function createRateLimiter({
  limit,
  windowMs = 60_000,
  now = () => Date.now(),
  maxKeys = DEFAULT_RATE_MAX_KEYS,
} = {}) {
  const enabled = typeof limit === "number" && limit > 0;
  const cap = Number.isInteger(maxKeys) && maxKeys > 0 ? maxKeys : DEFAULT_RATE_MAX_KEYS;
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const buckets = new Map();

  function prune(t) {
    for (const [k, b] of buckets) {
      if (t >= b.resetAt) buckets.delete(k);
    }
  }

  function evictOldest() {
    const first = buckets.keys().next().value;
    if (first !== undefined) buckets.delete(first);
  }

  function verdictFor(b, t) {
    if (!b || t >= b.resetAt) {
      return { allowed: true, remaining: limit, retryAfterSec: 0 };
    }
    if (b.count >= limit) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((b.resetAt - t) / 1000) };
    }
    return { allowed: true, remaining: limit - b.count, retryAfterSec: 0 };
  }

  return {
    /**
     * Inspect a key without consuming a slot. Used so a bearer-present
     * request can be refused before auth work when the address bucket is
     * already exhausted by prior unauthenticated / failed-auth traffic.
     *
     * @param {string} key
     * @returns {RateVerdict}
     */
    peek(key) {
      if (!enabled) return { allowed: true, remaining: Infinity, retryAfterSec: 0 };
      return verdictFor(buckets.get(key), now());
    },
    check(key) {
      if (!enabled) return { allowed: true, remaining: Infinity, retryAfterSec: 0 };
      const t = now();
      let b = buckets.get(key);
      if (!b || t >= b.resetAt) {
        if (!b && buckets.size >= cap) {
          prune(t);
          if (buckets.size >= cap) evictOldest();
        }
        b = { count: 0, resetAt: t + windowMs };
        buckets.set(key, b);
      }
      b.count += 1;
      if (b.count > limit) {
        return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((b.resetAt - t) / 1000) };
      }
      return { allowed: true, remaining: limit - b.count, retryAfterSec: 0 };
    },
    size() { return buckets.size; },
  };
}

/**
 * Rate-limit key for a verified principal. Built only from identity fields
 * minted after token validation (`sub` + `clientId`). Never from a header.
 *
 * @param {object|null|undefined} identity
 * @returns {?string}
 */
export function rateLimitPrincipalKey(identity) {
  if (!identity || typeof identity !== "object") return null;
  if (identity.localOperator === true) return "principal:local-operator";
  const sub = identity.sub === undefined || identity.sub === null ? "" : String(identity.sub);
  const clientId = identity.clientId === undefined || identity.clientId === null
    ? ""
    : String(identity.clientId);
  if (!sub && !clientId) return null;
  return `principal:${sub}\0${clientId}`;
}

/**
 * Rate-limit key for a resolved client address.
 *
 * @param {string} [address]
 * @returns {string}
 */
export function rateLimitAddressKey(address) {
  return `addr:${address || "unknown"}`;
}

/**
 * Parse a rate-limit integer. Unset/empty uses `fallback`. Non-numeric or
 * negative values become 0 (disabled), matching the pre-DEV-860 env reader.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function parseLimit(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Parse a positive integer environment/config value.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/**
 * Resolve standalone / hosted `/mcp` rate-limit options from the environment.
 *
 * Defaults (conservative, unchanged from #141 unless overridden):
 *   - non-loopback TLS: 120 requests / 60s for both address and principal
 *   - loopback / plain HTTP: off (0) unless a positive `MCP_RATE_LIMIT` is set
 *   - `MCP_RATE_LIMIT=0` disables the address limiter (and the principal
 *     limiter when `MCP_PRINCIPAL_RATE_LIMIT` is unset)
 *   - `MCP_PRINCIPAL_RATE_LIMIT` overrides the post-auth principal limit
 *   - `MCP_RATE_MAX_KEYS` hard-caps tracked keys (default 10_000)
 *
 * @param {object} [options]
 * @param {boolean} [options.hasTls]
 * @param {boolean} [options.loopbackBind]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{
 *   addressLimit: number,
 *   principalLimit: number,
 *   windowSec: number,
 *   windowMs: number,
 *   maxKeys: number,
 * }}
 */
export function resolveHttpRateLimitOptions({
  hasTls = false,
  loopbackBind = true,
  env = process.env,
} = {}) {
  const windowSec = parsePositiveInt(env.MCP_RATE_WINDOW_SEC, DEFAULT_RATE_WINDOW_SEC);
  const maxKeys = parsePositiveInt(env.MCP_RATE_MAX_KEYS, DEFAULT_RATE_MAX_KEYS);
  const fallback = (hasTls && !loopbackBind) ? DEFAULT_HTTPS_RATE_LIMIT : 0;
  const addressLimit = parseLimit(env.MCP_RATE_LIMIT, fallback);
  const principalLimit = env.MCP_PRINCIPAL_RATE_LIMIT === undefined
    || env.MCP_PRINCIPAL_RATE_LIMIT === ""
    ? addressLimit
    : parseLimit(env.MCP_PRINCIPAL_RATE_LIMIT, 0);
  return {
    addressLimit,
    principalLimit,
    windowSec,
    windowMs: windowSec * 1000,
    maxKeys,
  };
}

/**
 * Build the address and principal limiters used by the HTTPS `/mcp` handler.
 * When both limits are positive and equal they share one instance (one
 * `maxKeys` bound). A zero limit is `null` (that gate is off).
 *
 * @param {object} [options] `resolveHttpRateLimitOptions` result, or the
 *   `{ hasTls, loopbackBind, env }` input to that function. `now` is forwarded.
 * @returns {{ rateLimiter: ReturnType<typeof createRateLimiter>|null, principalLimiter: ReturnType<typeof createRateLimiter>|null }}
 */
export function createHttpRateLimiters(options = {}) {
  const resolved = typeof options.addressLimit === "number"
    ? options
    : resolveHttpRateLimitOptions(options);
  const { addressLimit, principalLimit, windowMs, maxKeys } = resolved;
  const now = options.now;
  const address = addressLimit > 0
    ? createRateLimiter({ limit: addressLimit, windowMs, maxKeys, now })
    : null;
  let principal = null;
  if (principalLimit > 0) {
    principal = (address && principalLimit === addressLimit)
      ? address
      : createRateLimiter({ limit: principalLimit, windowMs, maxKeys, now });
  }
  return { rateLimiter: address, principalLimiter: principal };
}
