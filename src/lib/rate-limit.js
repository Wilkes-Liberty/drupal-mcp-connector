/**
 * Minimal, dependency-free fixed-window rate limiter for the HTTPS transport.
 *
 * Opt-in: with a falsy/non-positive `limit` it's a no-op (always allows), so the
 * default behavior is unchanged. Counts are kept in-memory per process and keyed
 * by an arbitrary string (the caller chooses, e.g. client IP). Suited to a
 * single-process connector fronting one Drupal; for multi-replica deployments
 * put a shared limiter in the reverse proxy instead.
 */

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
 * @param {number}  [opts.maxKeys]   Soft cap on tracked keys before expired ones are pruned (default 10_000).
 * @returns {{ check: (key: string) => RateVerdict, size: () => number }}
 */
export function createRateLimiter({ limit, windowMs = 60_000, now = () => Date.now(), maxKeys = 10_000 } = {}) {
  const enabled = typeof limit === "number" && limit > 0;
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const buckets = new Map();

  function prune(t) {
    for (const [k, b] of buckets) {
      if (t >= b.resetAt) buckets.delete(k);
    }
  }

  return {
    check(key) {
      if (!enabled) return { allowed: true, remaining: Infinity, retryAfterSec: 0 };
      const t = now();
      let b = buckets.get(key);
      if (!b || t >= b.resetAt) {
        if (buckets.size >= maxKeys) prune(t);
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
