/**
 * Guarded live link checker — opt-in outbound HTTP for the broken-links audit.
 *
 * Single responsibility: given a set of URLs, perform bounded liveness checks
 * (HEAD, falling back to GET) and report each URL's status. Outbound HTTP is a
 * privileged capability, so this module is the one place network egress is
 * allowed during an audit, and only when the caller explicitly opts in.
 *
 * Safeguards (see checkLinks):
 *   - SSRF guard: only http(s); refuse loopback/private/link-local/metadata
 *     hosts and IP literals in private ranges.
 *   - Allowlist: external hosts are skipped unless listed in
 *     `allowedHosts`; same-origin (internal) hosts are always allowed.
 *   - Caps: bounded concurrency, per-request timeout, and a hard ceiling on the
 *     number of URLs checked (results flag `truncated` when the ceiling is hit).
 */

import nodeFetch from "node-fetch";

/** Default per-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 5000;
/** Default number of concurrent in-flight checks. */
export const DEFAULT_CONCURRENCY = 5;
/** Default hard ceiling on URLs checked in one call. */
export const DEFAULT_MAX_LINKS = 200;

/**
 * Hostnames that must never be probed regardless of allowlist — loopback and
 * cloud metadata endpoints.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

/**
 * Decide whether a URL is safe to probe: http(s) only, and not pointed at a
 * loopback, private, link-local, unique-local, or metadata address. Hostnames
 * that are not IP literals are allowed past the IP-range check (DNS is not
 * resolved here); the allowlist in checkLinks is the second gate for those.
 *
 * @param {string} url Absolute URL to validate.
 * @returns {{safe: boolean, reason: ?string, host: ?string}} Verdict.
 */
export function isSafeUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { return { safe: false, reason: "unparseable URL", host: null }; }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `unsupported protocol ${parsed.protocol}`, host: parsed.host };
  }

  // URL.hostname returns IPv6 literals wrapped in brackets; strip them so the
  // range checks below see a bare address.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    return { safe: false, reason: "loopback host", host: parsed.host };
  }
  if (isPrivateIp(hostname)) {
    return { safe: false, reason: "private or link-local address", host: parsed.host };
  }
  return { safe: true, reason: null, host: parsed.host };
}

/**
 * Whether a hostname is an IP literal in a loopback/private/link-local/ULA range.
 * Non-IP hostnames return false (resolution happens at fetch time, not here).
 * @param {string} hostname Lowercased hostname from a URL.
 * @returns {boolean} True when the literal IP is in a blocked range.
 */
function isPrivateIp(hostname) {
  // IPv6 literals arrive bracket-stripped from URL.hostname.
  if (hostname.includes(":")) {
    if (hostname === "::1") return true;                 // loopback
    if (hostname.startsWith("fe80")) return true;        // link-local
    if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true; // ULA
    if (hostname.startsWith("::ffff:")) return isPrivateIp(hostname.slice(7)); // mapped v4
    return false;
  }
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true;                            // 127.0.0.0/8 loopback
  if (a === 10) return true;                             // 10.0.0.0/8
  if (a === 0) return true;                              // 0.0.0.0/8
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16
  return false;
}

/**
 * Check a list of URLs for liveness with bounded concurrency.
 *
 * @param {string[]} urls URLs to check (duplicates are de-duped).
 * @param {object} [opts]
 * @param {string[]} [opts.allowedHosts] Hosts allowed for external probes. A
 *   same-origin host (see opts.internalHost) is always allowed.
 * @param {?string} [opts.internalHost] The site's own host; never needs listing.
 * @param {number} [opts.maxConcurrency] In-flight cap (default 5).
 * @param {number} [opts.timeoutMs] Per-request timeout (default 5000).
 * @param {number} [opts.maxLinks] Hard ceiling on URLs checked (default 200).
 * @param {Function} [opts.fetchImpl] Injected fetch (for tests); defaults to node-fetch.
 * @returns {Promise<{checked: number, truncated: boolean, results: Array<{
 *   url: string, ok: boolean, status: ?number, skipped: boolean, reason: ?string}>}>}
 */
export async function checkLinks(urls, opts = {}) {
  const {
    allowedHosts = [],
    internalHost = null,
    maxConcurrency = DEFAULT_CONCURRENCY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxLinks = DEFAULT_MAX_LINKS,
    fetchImpl = nodeFetch,
  } = opts;

  const allow = new Set(allowedHosts.map((h) => String(h).toLowerCase()));
  if (internalHost) allow.add(String(internalHost).toLowerCase());

  const unique = [...new Set(urls)];
  const truncated = unique.length > maxLinks;
  const queue = unique.slice(0, maxLinks);

  const results = [];
  let cursor = 0;
  /**
   * Worker: pull URLs off the shared queue until drained.
   * @returns {Promise<void>}
   */
  async function worker() {
    while (cursor < queue.length) {
      const url = queue[cursor++];
      results.push(await checkOne(url, { allow, timeoutMs, fetchImpl }));
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(maxConcurrency, queue.length)) }, worker);
  await Promise.all(workers);

  return { checked: results.length, truncated, results };
}

/**
 * Check a single URL, applying the SSRF guard and host allowlist before any
 * network call. Safe failures (blocked/not-allowlisted) are returned as
 * `skipped`, not errors.
 * @param {string} url URL to check.
 * @param {{allow: Set<string>, timeoutMs: number, fetchImpl: Function}} ctx Shared context.
 * @returns {Promise<{url: string, ok: boolean, status: ?number, skipped: boolean, reason: ?string}>}
 */
async function checkOne(url, { allow, timeoutMs, fetchImpl }) {
  const guard = isSafeUrl(url);
  if (!guard.safe) {
    return { url, ok: false, status: null, skipped: true, reason: guard.reason };
  }
  if (!allow.has(guard.host.toLowerCase())) {
    return { url, ok: false, status: null, skipped: true, reason: "host not in allowlist" };
  }

  // HEAD first; some servers reject HEAD (405/501) so retry once with GET.
  const head = await timedFetch(url, "HEAD", { timeoutMs, fetchImpl });
  if (head.status && head.status !== 405 && head.status !== 501) {
    return finalize(url, head);
  }
  const get = await timedFetch(url, "GET", { timeoutMs, fetchImpl });
  return finalize(url, get);
}

/**
 * Build the public result record from a fetch outcome. Treats 2xx/3xx as ok.
 * @param {string} url URL checked.
 * @param {{status: ?number, error: ?string}} res Fetch outcome.
 * @returns {{url: string, ok: boolean, status: ?number, skipped: boolean, reason: ?string}}
 */
function finalize(url, res) {
  if (res.error) return { url, ok: false, status: null, skipped: false, reason: res.error };
  const ok = res.status >= 200 && res.status < 400;
  return { url, ok, status: res.status, skipped: false, reason: ok ? null : `HTTP ${res.status}` };
}

/**
 * Perform a single fetch with an abort-based timeout. Never throws — network and
 * timeout failures are returned as `{ status: null, error }`.
 * @param {string} url URL to fetch.
 * @param {"HEAD"|"GET"} method HTTP method.
 * @param {{timeoutMs: number, fetchImpl: Function}} ctx Timeout + fetch impl.
 * @returns {Promise<{status: ?number, error: ?string}>}
 */
async function timedFetch(url, method, { timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method, redirect: "follow", signal: controller.signal });
    return { status: res.status, error: null };
  } catch (err) {
    const reason = err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : (err?.message || "request failed");
    return { status: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
