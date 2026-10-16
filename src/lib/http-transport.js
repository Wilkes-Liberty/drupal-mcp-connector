/**
 * Streamable HTTP transport helpers (DEV-840).
 *
 * Conformance helpers for MCP revision 2026-07-28, plus the dual-era
 * 2025 sessionful compatibility arm. Origin validation, protocol-version
 * allowlisting, Accept checks, JSON-RPC batch rejection, and principal
 * binding for leftover 2025 sessions live here so the request handler
 * stays a thin wire-up. Session ids never replace per-request token
 * validation.
 */

import { fromIdentity } from "./principal-key.js";

/** Current Streamable HTTP / core protocol revision this connector targets. */
export const MCP_PROTOCOL_VERSION_CURRENT = "2026-07-28";

/**
 * Protocol versions this connector will serve. 2026-07-28 is current;
 * 2025-* remain only for the time-boxed legacy HTTP arm.
 */
export const MCP_PROTOCOL_VERSIONS = Object.freeze([
  MCP_PROTOCOL_VERSION_CURRENT,
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
]);

/** JSON-RPC error code the SDK uses for an unsupported protocol version. */
export const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;

/**
 * Whether `version` is a protocol revision this connector serves.
 *
 * @param {unknown} version
 * @returns {boolean}
 */
export function isSupportedProtocolVersion(version) {
  return MCP_PROTOCOL_VERSIONS.includes(String(version || "").trim());
}

/**
 * Exact Cursor apex Origin (DEV-953). Matching is the full origin string
 * after {@link normalizeOrigin} — no wildcards, prefixes, or scheme swaps.
 * This is the Origin the Cursor browser client sends on `/mcp`.
 */
export const CURSOR_BROWSER_ORIGIN = "https://cursor.com";

/**
 * Exact Cursor www Origin (DEV-953). Matches the cursor-mcp redirect
 * `https://www.cursor.com/agents/mcp/oauth/callback` in keystone#1539
 * (`scripts/keycloak/setup-realm.sh`).
 */
export const CURSOR_WWW_BROWSER_ORIGIN = "https://www.cursor.com";

/**
 * Exact Grok Bot browser Origin (DEV-953). Matches the grok-bot redirect
 * `https://grok.com/connectors-oauth-exchange-code/` in keystone#1539.
 */
export const GROK_BOT_BROWSER_ORIGIN = "https://grok.com";

/**
 * Exact xAI console Origin (DEV-953). Matches the grok-bot redirect
 * `https://console.x.ai/connectors-oauth-exchange-code/` in keystone#1539.
 */
export const GROK_BOT_CONSOLE_ORIGIN = "https://console.x.ai";

/**
 * Documented Cursor browser origins for operators to copy into
 * `auth.allowedOrigins` / `MCP_ALLOWED_ORIGINS`.
 *
 * @type {readonly string[]}
 */
export const CURSOR_BROWSER_ORIGINS = Object.freeze([
  CURSOR_BROWSER_ORIGIN,
  CURSOR_WWW_BROWSER_ORIGIN,
]);

/**
 * HTTPS Origins of the pre-registered public PKCE clients in keystone#1539
 * (`cursor-mcp` and `grok-bot`), plus {@link CURSOR_BROWSER_ORIGIN}.
 * Copy these into `auth.allowedOrigins` / `MCP_ALLOWED_ORIGINS`. Not applied
 * automatically — an omitted or empty extra list refuses every present
 * third-party Origin (fail closed). The origin of `auth.resource` /
 * `auth.audience` is still auto-included (same-origin). Loopback
 * `http://localhost:8787/callback` is a desktop redirect, not a hosted
 * `/mcp` Origin.
 *
 * @type {readonly string[]}
 */
export const HOSTED_PUBLIC_CLIENT_ORIGINS = Object.freeze([
  CURSOR_BROWSER_ORIGIN,
  CURSOR_WWW_BROWSER_ORIGIN,
  GROK_BOT_BROWSER_ORIGIN,
  GROK_BOT_CONSOLE_ORIGIN,
]);

/**
 * Normalize a configured or header Origin to `https://host[:port]`.
 * Returns null when the value is missing or not an absolute URL.
 *
 * @param {unknown} value
 * @returns {?string}
 */
export function normalizeOrigin(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Split a config array or comma/space-separated env string into raw origin
 * tokens. Values are not normalized here.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseOriginList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

/**
 * Resolve the configured Origin list before normalization (DEV-953).
 *
 * Fail closed for extra Origins: an omitted or empty config list is empty.
 * A present `envValue` (`MCP_ALLOWED_ORIGINS`) replaces config, including
 * an empty string. Values are not normalized here —
 * {@link resolveAllowedOrigins} then adds the resource/audience origin.
 * Matching is exact origin strings only; there is no wildcard path and no
 * implicit Cursor default.
 *
 * @param {unknown} configured `auth.allowedOrigins` (array or string).
 * @param {unknown} [envValue] Raw `MCP_ALLOWED_ORIGINS` when the env key is present.
 * @returns {string[]}
 */
export function resolveConfiguredOrigins(configured, envValue) {
  if (envValue !== undefined) {
    return parseOriginList(envValue);
  }
  return parseOriginList(configured);
}

/**
 * Build the Origin allowlist. Env/config extra entries are normalized; the
 * origin of `resource` (or `audience`) is always included when it is an
 * absolute http(s) URL so a same-origin browser client works without extra
 * config. An empty extra list therefore still allows that resource origin
 * and refuses every other present Origin.
 *
 * @param {object} [options]
 * @param {unknown} [options.allowedOrigins]
 * @param {string} [options.resource]
 * @param {string} [options.audience]
 * @returns {readonly string[]}
 */
export function resolveAllowedOrigins({
  allowedOrigins = [],
  resource = "",
  audience = "",
} = {}) {
  const listed = new Set();
  for (const item of parseOriginList(allowedOrigins)) {
    const origin = normalizeOrigin(item);
    if (origin) listed.add(origin);
  }
  const auto = normalizeOrigin(resource) || normalizeOrigin(audience);
  if (auto) listed.add(auto);
  return Object.freeze([...listed]);
}

/**
 * DNS-rebinding / browser Origin guard. This is not authentication. A
 * missing Origin is allowed by design so non-browser clients (desktop
 * Cursor, Grok Bot, curl, CI) can connect. A present Origin must be an
 * exact allowlist entry after {@link normalizeOrigin} — `https://cursor.com`
 * does not match `http://cursor.com`, `https://cursor.com.evil.test`,
 * or `https://cursor.com.evil.example`. There is no suffix match and the
 * request Origin is never reflected.
 * The literal `null` origin is refused unless explicitly listed.
 *
 * @param {unknown} originHeader
 * @param {readonly string[]} allowlist
 * @returns {boolean}
 */
export function originAllowed(originHeader, allowlist) {
  if (originHeader === undefined || originHeader === null || originHeader === "") {
    return true;
  }
  const trimmed = String(originHeader).trim();
  if (trimmed.toLowerCase() === "null") {
    return allowlist.includes("null");
  }
  const origin = normalizeOrigin(trimmed);
  if (!origin) return false;
  return allowlist.includes(origin);
}

/** Hostnames treated as loopback for the default Host allowlist. */
export const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);

/**
 * Decimal port written on a host[:port] token. WHATWG `http:` hides `:80`,
 * so callers recover it from the original token rather than `url.port`.
 *
 * @param {string} token
 * @returns {string}
 */
function explicitHostPort(token) {
  let port = "";
  if (token.startsWith("[")) {
    const close = token.lastIndexOf("]:");
    if (close !== -1) port = token.slice(close + 2);
  } else {
    const colon = token.lastIndexOf(":");
    if (colon !== -1 && token.indexOf(":") === colon) {
      port = token.slice(colon + 1);
    }
  }
  if (!/^\d+$/.test(port)) return "";
  const n = Number(port);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return "";
  return String(n);
}

/**
 * Parse `Host` into hostname + optional port. The raw grammar is checked
 * first (reg-name, IPv4, or bracketed IPv6, with an optional decimal port);
 * `URL` is used only to canonicalize the hostname.
 *
 * @param {unknown} value
 * @returns {?{hostname: string, port: string}}
 */
export function parseHostHeader(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  // Host is `host [":" port]` only: reg-name, IPv4, or bracketed IPv6
  // characters plus a port separator. Userinfo, path, query, fragment,
  // backslash, and zone-id delimiters are URL syntax that `URL` would
  // silently absorb (`evil.example@mcp.example.com` parses to hostname
  // `mcp.example.com`), so they are refused before `URL` sees the value.
  if (!raw || !/^[[\]a-z0-9:._-]+$/.test(raw)) return null;
  const urlHost = raw.startsWith("[") || /^[^:]+:\d+$/.test(raw)
    ? raw
    : (raw.includes(":") ? `[${raw}]` : raw);
  try {
    const url = new URL(`http://${urlHost}`);
    let hostname = url.hostname;
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }
    hostname = hostname.replace(/\.$/, "");
    if (!hostname) return null;
    return { hostname, port: url.port || explicitHostPort(raw) };
  } catch {
    return null;
  }
}

/**
 * Normalize a Host token to `hostname` or `hostname:port` (port kept only
 * when the value named one). IPv6 literals with a port are bracketed
 * (`[::1]:3443`) so the token round-trips through `parseHostHeader`.
 * Returns null when the value is missing or not a host[:port] token.
 *
 * @param {unknown} value
 * @returns {?string}
 */
export function normalizeHost(value) {
  const parsed = parseHostHeader(value);
  if (!parsed) return null;
  if (!parsed.port) return parsed.hostname;
  const name = parsed.hostname.includes(":") ? `[${parsed.hostname}]` : parsed.hostname;
  return `${name}:${parsed.port}`;
}

/**
 * Split a config array or comma/space-separated env string into raw Host
 * tokens. Values are not normalized here.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseHostList(value) {
  return parseOriginList(value);
}

/**
 * Hostname of an absolute http(s) URL, or a bare host token.
 *
 * @param {unknown} value
 * @returns {?string}
 */
function hostFromResource(value) {
  const origin = normalizeOrigin(value);
  if (origin) {
    return parseHostHeader(new URL(origin).host)?.hostname ?? null;
  }
  return parseHostHeader(value)?.hostname ?? null;
}

/**
 * Build the Host allowlist (DEV-861). Env/config entries are normalized;
 * the host of `resource` (or `audience`) is always included; loopback
 * hostnames are added when the process binds loopback so a local client
 * can present `Host: 127.0.0.1[:port]`.
 *
 * @param {object} [options]
 * @param {unknown} [options.allowedHosts]
 * @param {string} [options.resource]
 * @param {string} [options.audience]
 * @param {boolean} [options.loopbackBind]
 * @returns {readonly string[]}
 */
export function resolveAllowedHosts({
  allowedHosts = [],
  resource = "",
  audience = "",
  loopbackBind = false,
} = {}) {
  const listed = new Set();
  for (const item of parseHostList(allowedHosts)) {
    const host = normalizeHost(item);
    if (host) listed.add(host);
  }
  const auto = hostFromResource(resource) || hostFromResource(audience);
  if (auto) listed.add(auto);
  if (loopbackBind) {
    for (const host of LOOPBACK_HOSTS) listed.add(host);
  }
  return Object.freeze([...listed]);
}

/**
 * DNS-rebinding / Host-header guard. A missing or unparseable Host is
 * refused. A hostname-only allowlist entry matches any port; an entry
 * that names a port matches only that port.
 *
 * @param {unknown} hostHeader
 * @param {readonly string[]} allowlist
 * @returns {boolean}
 */
export function hostAllowed(hostHeader, allowlist) {
  const incoming = parseHostHeader(hostHeader);
  if (!incoming) return false;
  return allowlist.some((entry) => {
    const allowed = parseHostHeader(entry);
    if (!allowed) return false;
    if (incoming.hostname !== allowed.hostname) return false;
    if (!allowed.port) return true;
    return incoming.port === allowed.port;
  });
}

/**
 * Stable principal key for binding a 2025-era session. Same Paladin
 * `iss|sub|actor` (the mcp_sentinel twin) is the same principal (token
 * refresh). A local-operator identity shares one loopback key.
 * Unidentifiable identities return null so a session cannot be minted
 * or reused. `#455` previously keyed on `sub`+`clientId`; that formula
 * lives on the `fromIdentity` twin now.
 *
 * @param {object|null|undefined} identity
 * @returns {?string}
 */
export function sessionPrincipalKey(identity) {
  if (!identity) return null;
  if (identity.localOperator === true) return "local-operator";
  try {
    return fromIdentity(identity).principalKey;
  } catch {
    return null;
  }
}

/**
 * Parse an Accept header into media ranges with their quality values
 * (RFC 9110 §12.5.1). Unparseable entries are dropped; a missing or
 * malformed `q` counts as 1.
 *
 * @param {unknown} acceptHeader
 * @returns {Array<{type: string, subtype: string, q: number, specificity: number}>}
 */
function parseAcceptRanges(acceptHeader) {
  const ranges = [];
  for (const entry of String(acceptHeader).split(",")) {
    const [media, ...params] = entry.split(";");
    const range = media.trim().toLowerCase();
    const slash = range.indexOf("/");
    if (slash <= 0 || slash === range.length - 1) continue;
    const type = range.slice(0, slash);
    const subtype = range.slice(slash + 1);
    if (type === "*" && subtype !== "*") continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map((part) => part.trim().toLowerCase());
      if (key !== "q") continue;
      const parsed = Number(value);
      q = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
    }
    const specificity = type === "*" ? 0 : (subtype === "*" ? 1 : 2);
    ranges.push({ type, subtype, q, specificity });
  }
  return ranges;
}

/**
 * Whether the Accept header allows the given media type. The most specific
 * matching range decides (exact beats `type/*` beats `*\/*`), and a matching
 * range with `q=0` forbids the type even when a broader range would allow it.
 *
 * @param {unknown} acceptHeader
 * @param {string} type
 * @returns {boolean}
 */
export function acceptIncludes(acceptHeader, type) {
  if (acceptHeader === undefined || acceptHeader === null) return false;
  const [wantType, wantSubtype] = String(type).toLowerCase().split("/");
  let best = null;
  for (const range of parseAcceptRanges(acceptHeader)) {
    const typeMatches = range.type === "*" || range.type === wantType;
    const subtypeMatches = range.subtype === "*" || range.subtype === wantSubtype;
    if (!typeMatches || !subtypeMatches) continue;
    if (!best || range.specificity > best.specificity) best = range;
  }
  return Boolean(best) && best.q > 0;
}

/**
 * Accept-header check for the MCP endpoint. A missing header is allowed
 * (non-browser clients sometimes omit it). A present header, including an
 * empty one, must list a type the method can answer with.
 *
 * @param {string} method
 * @param {unknown} acceptHeader
 * @returns {boolean}
 */
export function mcpAcceptOk(method, acceptHeader) {
  if (acceptHeader === undefined || acceptHeader === null) {
    return true;
  }
  if (method === "GET") {
    return acceptIncludes(acceptHeader, "text/event-stream");
  }
  if (method === "POST") {
    return acceptIncludes(acceptHeader, "application/json")
      || acceptIncludes(acceptHeader, "text/event-stream");
  }
  return true;
}

/**
 * True when the parsed POST body is a JSON-RPC 2.0 batch (an array).
 * Revision 2026-07-28 requires a single request or notification per POST.
 *
 * @param {unknown} body
 * @returns {boolean}
 */
export function isJsonRpcBatch(body) {
  return Array.isArray(body);
}

/**
 * True when the parsed body is a JSON-RPC notification (no `id`).
 *
 * @param {unknown} body
 * @returns {boolean}
 */
export function isJsonRpcNotification(body) {
  return Boolean(
    body
    && typeof body === "object"
    && !Array.isArray(body)
    && body.jsonrpc === "2.0"
    && typeof body.method === "string"
    && !Object.hasOwn(body, "id"),
  );
}

/**
 * True when the parsed body is a JSON-RPC response (no `method`).
 *
 * @param {unknown} body
 * @returns {boolean}
 */
export function isJsonRpcResponse(body) {
  return Boolean(
    body
    && typeof body === "object"
    && !Array.isArray(body)
    && body.jsonrpc === "2.0"
    && Object.hasOwn(body, "id")
    && !Object.hasOwn(body, "method")
    && (Object.hasOwn(body, "result") || Object.hasOwn(body, "error")),
  );
}
