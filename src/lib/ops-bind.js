/**
 * Mesh-only bind rules for the ops listener (DEV-863).
 *
 * `/ready` and `/metrics` are never served on the public MCP listener.
 * When `MCP_OPS_LISTEN` (or `ops.listen`) is set, the process may bind
 * that extra socket only to loopback or a Tailscale address. `0.0.0.0`,
 * `::`, and any other public or non-mesh address are fatal at startup.
 */

import { BlockList, isIP } from "node:net";
import { isLoopbackBind } from "./http-auth.js";
import { normalizeIp } from "./client-address.js";

/**
 * Test-only guard (DEV-863). Production callers never flip this. When
 * `required` is false, a public / wildcard bind is admitted — the
 * pre-guard behavior used to prove the refusal test can fail.
 *
 * @type {{required: boolean}}
 */
export const OPS_BIND_GUARD = { required: true };

/**
 * Flip {@link OPS_BIND_GUARD} for a red-run. Restore `true` after the
 * assertion; production code never calls this.
 *
 * @param {boolean} required
 * @returns {void}
 */
export function setOpsBindGuard(required) {
  OPS_BIND_GUARD.required = Boolean(required);
}

/** Tailscale CGNAT (IPv4) and Tailscale ULA (IPv6). */
const MESH_BIND_LIST = new BlockList();
MESH_BIND_LIST.addSubnet("127.0.0.0", 8, "ipv4");
MESH_BIND_LIST.addAddress("::1", "ipv6");
MESH_BIND_LIST.addSubnet("100.64.0.0", 10, "ipv4");
MESH_BIND_LIST.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/**
 * Named startup refusal when the ops listen spec cannot be parsed.
 */
export const OPS_LISTEN_PARSE_REASON =
  "MCP_OPS_LISTEN must be <addr:port> (IPv6 as [addr]:port). Empty disables the ops listener.";

/**
 * Named startup refusal for a disallowed ops bind address.
 *
 * @param {string} host
 * @returns {string}
 */
export function opsBindRefusedReason(host) {
  return (
    "ops listener may bind only to loopback or a Tailscale address " +
    `(100.64.0.0/10 or fd7a:115c:a1e0::/48). Refusing ${host}.`
  );
}

/**
 * Whether `host` is an IP on the ops bind list (loopback or Tailscale).
 *
 * @param {string} host
 * @returns {boolean}
 */
function meshIpAllowed(host) {
  const ip = normalizeIp(host);
  if (!ip) return false;
  if (ip === "0.0.0.0" || ip === "::") return false;
  const version = isIP(ip);
  if (version === 4) return MESH_BIND_LIST.check(ip, "ipv4");
  if (version === 6) return MESH_BIND_LIST.check(ip, "ipv6");
  return false;
}

/**
 * Whether the ops listener may bind `host`. Loopback hostnames and
 * Tailscale literals only. Hostnames other than `localhost` are refused
 * (no DNS) so a public name cannot silently widen exposure.
 *
 * @param {unknown} host
 * @returns {boolean}
 */
export function isOpsBindAllowed(host) {
  if (!OPS_BIND_GUARD.required) return true;
  if (typeof host !== "string" || !host.trim()) return false;
  const value = host.trim();
  if (isLoopbackBind(value)) return true;
  return meshIpAllowed(value);
}

/**
 * Parse `MCP_OPS_LISTEN` / `ops.listen`. Empty or unset is disabled.
 * A present but unparseable value is a fatal error (they tried to enable it).
 *
 * @param {unknown} spec
 * @returns {{enabled: false, error?: string}|{enabled: true, host: string, port: number}}
 */
export function parseOpsListen(spec) {
  if (spec === undefined || spec === null) return { enabled: false };
  const raw = String(spec).trim();
  if (!raw) return { enabled: false };

  let host;
  let portStr;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 2) return { enabled: false, error: OPS_LISTEN_PARSE_REASON };
    host = raw.slice(1, end);
    if (raw.slice(end + 1, end + 2) !== ":") {
      return { enabled: false, error: OPS_LISTEN_PARSE_REASON };
    }
    portStr = raw.slice(end + 2);
  } else {
    const colon = raw.lastIndexOf(":");
    if (colon <= 0 || colon === raw.length - 1) {
      return { enabled: false, error: OPS_LISTEN_PARSE_REASON };
    }
    host = raw.slice(0, colon);
    portStr = raw.slice(colon + 1);
  }

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { enabled: false, error: OPS_LISTEN_PARSE_REASON };
  }
  if (!host) return { enabled: false, error: OPS_LISTEN_PARSE_REASON };
  return { enabled: true, host, port };
}

/**
 * Resolve the ops listen spec from env (wins when present) or config.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.config]
 * @returns {{
 *   enabled: boolean,
 *   host?: string,
 *   port?: number,
 *   fatal?: boolean,
 *   reason?: string,
 * }}
 */
export function resolveOpsListen({ env = process.env, config = {} } = {}) {
  const spec = env.MCP_OPS_LISTEN !== undefined
    ? env.MCP_OPS_LISTEN
    : config?.ops?.listen;
  const parsed = parseOpsListen(spec);
  if (!parsed.enabled) {
    if (parsed.error) return { enabled: false, fatal: true, reason: parsed.error };
    return { enabled: false };
  }
  if (!isOpsBindAllowed(parsed.host)) {
    return { enabled: false, fatal: true, reason: opsBindRefusedReason(parsed.host) };
  }
  return { enabled: true, host: parsed.host, port: parsed.port };
}
