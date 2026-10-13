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
 *   buckets are pruned first; if the map is still full, live quota state is
 *   never evicted. Keys that arrive while the map is full share one
 *   fail-closed overflow bucket, so a key spray can neither exhaust memory
 *   nor reset an already-denied key.
 * @returns {{ check: (key: string) => RateVerdict, peek: (key: string) => RateVerdict, reserve: (key: string) => RateVerdict & {commit: () => void, release: () => void}, size: () => number }}
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
  /** Shared bucket for keys admitted while the map is at capacity. */
  let overflow = null;
  const OVERFLOW_KEY = "\0overflow";
  /** In-flight reservations per key: bearer requests still awaiting auth. */
  const inflight = new Map();
  const held = (key) => inflight.get(key) || 0;

  function prune(t) {
    for (const [k, b] of buckets) {
      // A bucket with outstanding holds stays until they settle, so the
      // in-flight map can never outgrow the capped bucket map.
      if (t >= b.resetAt && !held(k)) buckets.delete(k);
    }
  }

  function overflowBucket(t) {
    if (!overflow || t >= overflow.resetAt) overflow = { count: 0, resetAt: t + windowMs };
    return overflow;
  }

  function consume(b, t, target) {
    if (b.count + held(target) >= limit) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((b.resetAt - t) / 1000) };
    }
    b.count += 1;
    return { allowed: true, remaining: limit - b.count - held(target), retryAfterSec: 0 };
  }

  function settle(target) {
    const left = held(target) - 1;
    if (left > 0) inflight.set(target, left);
    else inflight.delete(target);
  }

  function verdictFor(b, t, pending = 0) {
    if (!b || t >= b.resetAt) {
      return pending >= limit
        ? { allowed: false, remaining: 0, retryAfterSec: Math.ceil(windowMs / 1000) }
        : { allowed: true, remaining: limit - pending, retryAfterSec: 0 };
    }
    if (b.count + pending >= limit) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((b.resetAt - t) / 1000) };
    }
    return { allowed: true, remaining: limit - b.count - pending, retryAfterSec: 0 };
  }

  /**
   * Current bucket for `key` (reset or created as needed), or the overflow
   * bucket when the map is full. Returns the bucket and the key its
   * in-flight reservations are tracked under.
   */
  function bucketFor(key, t) {
    let b = buckets.get(key);
    if (b && t < b.resetAt) return { b, target: key };
    if (b && held(key)) {
      // Expired but still held: roll the window in place rather than
      // dropping the holds' bucket.
      b.count = 0;
      b.resetAt = t + windowMs;
      return { b, target: key };
    }
    if (!b && overflow && t < overflow.resetAt) {
      // A live overflow bucket stays authoritative for every unknown key
      // until its own window resets: capacity freed by an unrelated
      // bucket's expiry must not hand a denied key a fresh quota.
      return { b: overflow, target: OVERFLOW_KEY };
    }
    if (!b && buckets.size >= cap) {
      prune(t);
      // Fail closed: a full map never evicts a live bucket (that would let
      // a denied key spray its way back in). New keys share one bucket.
      if (buckets.size >= cap) return { b: overflowBucket(t), target: OVERFLOW_KEY };
    }
    b = { count: 0, resetAt: t + windowMs };
    buckets.set(key, b);
    return { b, target: key };
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
      const t = now();
      const b = buckets.get(key);
      if (!b && overflow && t < overflow.resetAt) return verdictFor(overflow, t, held(OVERFLOW_KEY));
      if (!b && buckets.size >= cap) {
        prune(t);
        if (buckets.size >= cap) return verdictFor(overflow, t, held(OVERFLOW_KEY));
      }
      return verdictFor(b, t, held(key));
    },
    check(key) {
      if (!enabled) return { allowed: true, remaining: Infinity, retryAfterSec: 0 };
      const t = now();
      const { b, target } = bucketFor(key, t);
      return consume(b, t, target);
    },
    /**
     * Atomically hold one slot for a request whose outcome is not known
     * yet (a bearer awaiting introspection). While held, the slot counts
     * against `check` and `peek` for the same key, so a concurrent burst
     * cannot all observe a free bucket. `commit()` turns the hold into a
     * consumed slot (failed auth); `release()` gives it back (verified
     * principal, which the principal limiter then charges). Either is a
     * no-op after the first call.
     *
     * @param {string} key
     * @returns {RateVerdict & {commit: () => void, release: () => void}}
     */
    reserve(key) {
      const noop = () => {};
      if (!enabled) return { allowed: true, remaining: Infinity, retryAfterSec: 0, commit: noop, release: noop };
      const t = now();
      const { b, target } = bucketFor(key, t);
      const verdict = verdictFor(b, t, held(target));
      if (!verdict.allowed) return { ...verdict, commit: noop, release: noop };
      inflight.set(target, held(target) + 1);
      let open = true;
      const close = () => {
        if (!open) return false;
        open = false;
        settle(target);
        return true;
      };
      return {
        allowed: true,
        remaining: verdict.remaining - 1,
        retryAfterSec: 0,
        commit: () => {
          if (!close()) return;
          // Charge the same target the hold was taken on: a hold on the
          // shared overflow bucket must not mint a fresh dedicated bucket.
          const tc = now();
          if (target === OVERFLOW_KEY) consume(overflowBucket(tc), tc, OVERFLOW_KEY);
          else consume(bucketFor(key, tc).b, tc, key);
        },
        release: () => {
          if (!close()) return;
          // A verified principal leaves no trace: an untouched bucket is
          // dropped so many verified addresses cannot fill the key cap.
          const b = buckets.get(key);
          if (target === key && b && b.count === 0 && !held(key)) buckets.delete(key);
        },
      };
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
  // Structural encoding: a NUL inside a claim cannot make two principals
  // share a bucket (`a\0b`/`c` vs `a`/`b\0c`). Same shape as the session key.
  return `principal:${JSON.stringify([sub, clientId])}`;
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
 * The two are always separate instances, each with its own `maxKeys` bound,
 * so unauthenticated address traffic can never crowd out or reset verified
 * principal quota. A zero limit is `null` (that gate is off).
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
  const principal = principalLimit > 0
    ? createRateLimiter({ limit: principalLimit, windowMs, maxKeys, now })
    : null;
  return { rateLimiter: address, principalLimiter: principal };
}
