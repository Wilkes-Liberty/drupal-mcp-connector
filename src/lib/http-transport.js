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
 * Build the Origin allowlist. Env/config entries are normalized; the origin
 * of `resource` (or `audience`) is always included when it is an absolute
 * http(s) URL so a same-origin browser client works without extra config.
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
 * DNS-rebinding guard. A missing Origin is allowed (non-browser clients such
 * as Cursor and Grok Bot typically omit it). A present Origin must be on the
 * allowlist. The literal `null` origin is refused unless explicitly listed.
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
 * Parse `Host` into hostname + optional port. Rejects absolute URLs and
 * values that are not a host[:port] token.
 *
 * @param {unknown} value
 * @returns {?{hostname: string, port: string}}
 */
export function parseHostHeader(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw.includes("://") || /[\s/]/.test(raw)) return null;
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
    return { hostname, port: url.port };
  } catch {
    return null;
  }
}

/**
 * Normalize a Host token to `hostname` or `hostname:port` (port kept only
 * when the value named one). Returns null when the value is missing or not
 * a host[:port] token.
 *
 * @param {unknown} value
 * @returns {?string}
 */
export function normalizeHost(value) {
  const parsed = parseHostHeader(value);
  if (!parsed) return null;
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
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
 * Stable principal key for binding a 2025-era session. Same `sub` +
 * `clientId` is the same principal (token refresh). A local-operator
 * identity shares one loopback key. Unidentifiable identities return
 * null so a session cannot be minted or reused.
 *
 * @param {object|null|undefined} identity
 * @returns {?string}
 */
export function sessionPrincipalKey(identity) {
  if (!identity) return null;
  if (identity.localOperator === true) return "local-operator";
  const sub = identity.sub === undefined || identity.sub === null ? "" : String(identity.sub);
  const clientId = identity.clientId === undefined || identity.clientId === null ? "" : String(identity.clientId);
  if (!sub && !clientId) return null;
  return `${sub}\0${clientId}`;
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
