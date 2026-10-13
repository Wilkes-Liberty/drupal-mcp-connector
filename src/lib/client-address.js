/**
 * Client-address resolution for the HTTPS /mcp rate limiter (DEV-860).
 *
 * Forwarded headers are attacker-controlled unless the immediate peer is on
 * an operator-configured trusted-proxy list. The default list is empty
 * (trust none): `X-Forwarded-For` is ignored and the socket address is used.
 * Caller-supplied identity headers are never an input here.
 */

import { BlockList, isIP } from "node:net";

/**
 * Normalize a textual IP for comparison. Strips brackets, an IPv4 `:port`,
 * an IPv6 zone id, and the `:ffff:` IPv4-mapped prefix. Non-IP strings
 * become `""`.
 *
 * @param {unknown} address
 * @returns {string}
 */
export function normalizeIp(address) {
  if (typeof address !== "string") return "";
  let value = address.trim();
  if (!value) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end > 1) value = value.slice(1, end);
  } else {
    const colon = value.lastIndexOf(":");
    const dot = value.indexOf(".");
    if (colon > 0 && dot > 0 && colon > dot && isIP(value.slice(0, colon)) === 4) {
      value = value.slice(0, colon);
    }
  }
  const zone = value.indexOf("%");
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith("::ffff:") && isIP(value.slice(7)) === 4) {
    value = value.slice(7);
  }
  return isIP(value) ? value : "";
}

/**
 * Split an `X-Forwarded-For` header into hop IPs, left-to-right
 * (original client first). Non-IP tokens are dropped.
 *
 * @param {unknown} header
 * @returns {string[]}
 */
export function parseForwardedFor(header) {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (typeof raw !== "string" || !raw.trim()) return [];
  const hops = [];
  for (const part of raw.split(",")) {
    const ip = normalizeIp(part);
    if (ip) hops.push(ip);
  }
  return hops;
}

/**
 * Parse a configured trusted-proxy list (CIDR or single IP). Empty / missing
 * means trust none. Invalid entries are skipped so a typo cannot widen trust.
 *
 * @param {unknown} value Array, or a comma/whitespace-separated string.
 * @returns {string[]}
 */
export function parseTrustedProxies(value) {
  if (value === undefined || value === null || value === "") return [];
  const items = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const out = [];
  for (const item of items) {
    const trimmed = String(item).trim();
    if (!trimmed) continue;
    if (isProxySpec(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Resolve the trusted-proxy list. `MCP_TRUSTED_PROXIES` replaces the
 * configured list when present, including an empty value (trust none).
 *
 * @param {object} [options]
 * @param {unknown} [options.trustedProxies] `auth.trustedProxies` (array or string).
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {string[]}
 */
export function resolveTrustedProxies({ trustedProxies, env = process.env } = {}) {
  if (env.MCP_TRUSTED_PROXIES !== undefined) {
    return parseTrustedProxies(env.MCP_TRUSTED_PROXIES);
  }
  return parseTrustedProxies(trustedProxies);
}

/**
 * Whether `address` is on the trusted-proxy list (exact IP or CIDR).
 *
 * @param {unknown} address
 * @param {readonly string[]} [proxies]
 * @returns {boolean}
 */
export function isTrustedProxy(address, proxies = []) {
  if (!proxies.length) return false;
  return createTrustedProxyMatcher(proxies)(address);
}

/**
 * Build a matcher for a trusted-proxy list. Prefer this when checking many
 * addresses against the same list.
 *
 * @param {readonly string[]} proxies
 * @returns {(address: unknown) => boolean}
 */
export function createTrustedProxyMatcher(proxies) {
  const list = new BlockList();
  for (const spec of proxies) {
    addProxySpec(list, spec);
  }
  return function match(address) {
    const ip = normalizeIp(address);
    const version = isIP(ip);
    if (version === 4) return list.check(ip, "ipv4");
    if (version === 6) return list.check(ip, "ipv6");
    return false;
  };
}

/**
 * Socket peer address, normalized. Missing or unparseable becomes `"unknown"`.
 *
 * @param {{socket?: {remoteAddress?: string}}} req
 * @returns {string}
 */
export function socketAddress(req) {
  return normalizeIp(req?.socket?.remoteAddress) || "unknown";
}

/**
 * Client address for rate-limit keys.
 *
 * Default (empty trusted list, or an untrusted peer): the socket address.
 * When the immediate peer is trusted, walk `X-Forwarded-For` from the right
 * and take the first hop that is not itself a trusted proxy (the client the
 * last trusted hop saw). A spoofed header from an untrusted peer is ignored.
 *
 * @param {{socket?: {remoteAddress?: string}, headers?: object}} req
 * @param {readonly string[]} [trustedProxies]
 * @returns {string}
 */
export function resolveClientAddress(req, trustedProxies = []) {
  const peer = socketAddress(req);
  if (!trustedProxies.length || peer === "unknown") return peer;
  const trusted = createTrustedProxyMatcher(trustedProxies);
  if (!trusted(peer)) return peer;
  const hops = parseForwardedFor(req?.headers?.["x-forwarded-for"]);
  if (!hops.length) return peer;
  for (const hop of hops.slice().reverse()) {
    if (!trusted(hop)) return hop;
  }
  return hops[0];
}

/**
 * @param {string} spec
 * @returns {boolean}
 */
function isProxySpec(spec) {
  const slash = spec.lastIndexOf("/");
  if (slash === -1) return isIP(normalizeIp(spec)) !== 0;
  const ip = normalizeIp(spec.slice(0, slash));
  const suffix = spec.slice(slash + 1);
  const bits = Number(suffix);
  const version = isIP(ip);
  // Number("") is 0; an empty suffix must not become a default route.
  if (version === 0 || suffix === "" || !Number.isInteger(bits) || bits < 0) return false;
  return version === 4 ? bits <= 32 : bits <= 128;
}

/**
 * @param {BlockList} list
 * @param {string} spec
 */
function addProxySpec(list, spec) {
  try {
    const slash = spec.lastIndexOf("/");
    if (slash === -1) {
      const ip = normalizeIp(spec);
      const version = isIP(ip);
      if (version === 4) list.addAddress(ip, "ipv4");
      else if (version === 6) list.addAddress(ip, "ipv6");
      return;
    }
    const ip = normalizeIp(spec.slice(0, slash));
    const bits = Number(spec.slice(slash + 1));
    const version = isIP(ip);
    if (version === 4) list.addSubnet(ip, bits, "ipv4");
    else if (version === 6) list.addSubnet(ip, bits, "ipv6");
  } catch {
    // A malformed spec must not throw into the request path; skip it.
  }
}
