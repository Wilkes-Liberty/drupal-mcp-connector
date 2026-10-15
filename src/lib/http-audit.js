/**
 * Hosted HTTP audit writer (DEV-858).
 *
 * Every hosted request — including refusals (401, 429, bad Origin, bad Host)
 * — leaves exactly one row. The writer is fail-safe: a sink error never
 * changes the HTTP verdict (rows are emitted after the response is finished).
 *
 * Rows are a closed field set. Bearer tokens, Authorization, Cookie,
 * Proxy-Authorization, and raw bodies are never copied in.
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/** Closed denial / outcome codes recorded on each hosted HTTP row. */
export const HTTP_AUDIT_CODES = Object.freeze([
  "unauthenticated",
  "invalid_token",
  "rate_limited",
  "bad_origin",
  "bad_host",
  "forbidden",
  "aborted",
  "ok",
]);

const CODE_SET = new Set(HTTP_AUDIT_CODES);
const TOOL_OUTCOMES = new Set(["success", "error", "denied"]);
const TOOL_RESULTS = new WeakMap();
const requestAuditStore = new AsyncLocalStorage();

/** Run dispatch with a private request reference, never caller arguments.
 * @param {object} req
 * @param {Function} fn
 * @returns {*}
 */
export function runWithHttpAudit(req, fn) {
  return requestAuditStore.run(req, fn);
}

/** Record a server-derived outcome. A policy denial cannot be overwritten
 * by an outer tool result; error likewise outranks success for nested calls.
 * @param {"success"|"error"|"denied"} outcome
 */
export function markHttpAuditToolOutcome(outcome) {
  const req = requestAuditStore.getStore();
  if (!req || !TOOL_OUTCOMES.has(outcome)) return;
  const previous = TOOL_RESULTS.get(req);
  if (previous === "denied" || (previous === "error" && outcome === "success")) return;
  TOOL_RESULTS.set(req, outcome);
}


const ATTACHED = new WeakSet();
const WRITTEN = new WeakSet();
/** Requests whose /mcp Origin check refused them (set by the handler that wrote the 403). */
const ORIGIN_REFUSED = new WeakSet();
/** Requests whose /mcp Host check refused them (set by the handler that wrote the 403). */
const HOST_REFUSED = new WeakSet();
/** Tenant resolved for a request, when the route resolved one. */
const TENANTS = new WeakMap();

const FORBIDDEN_ROW_KEYS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "proxyauthorization",
  "body",
  "token",
  "headers",
  "raw",
  "rawbody",
  "set-cookie",
]);

const MAX_REQUEST_ID = 128;
const MAX_BUFFERED_ROWS = 10_000;

/**
 * When false, {@link defaultHttpAuditSink} does not write. Production leaves
 * this true. The test setup turns it off in-process so a suite does not
 * flood the log. No environment variable is consulted.
 */
let writeDefaultHttpAuditSink = true;

/**
 * Enable or silence the default stderr audit sink. Tests call this from
 * Vitest setup. Production does not.
 *
 * @param {boolean} enabled
 * @returns {void}
 */
export function setDefaultHttpAuditSinkEnabled(enabled) {
  writeDefaultHttpAuditSink = Boolean(enabled);
}

/**
 * Default production sink: one JSON line on stderr. Callers that must stay
 * quiet pass their own sink, or tests call {@link setDefaultHttpAuditSinkEnabled}.
 *
 * @param {object} row
 */
export function defaultHttpAuditSink(row) {
  if (!writeDefaultHttpAuditSink) return;
  try {
    process.stderr.write(`[drupal-mcp-http-audit] ${JSON.stringify(row)}\n`);
  } catch {
    // Fail-safe: a sink error must never become a request verdict.
  }
}

/**
 * Header value by name (case-insensitive). The value is used only to decide
 * presence or to compare request-id; callers must not persist secrets.
 *
 * @param {import("http").IncomingMessage|{headers?: object}} req
 * @param {string} name
 * @returns {string|undefined}
 */
function headerValue(req, name) {
  const headers = req?.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * Bearer token string, if present. Used only to scrub leaks; never written.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {?string}
 */
function bearerSecret(req) {
  const value = headerValue(req, "authorization");
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * Cookie header string, if present. Used only to scrub leaks; never written.
 *
 * @param {import("http").IncomingMessage} req
 * @returns {?string}
 */
function cookieSecret(req) {
  const value = headerValue(req, "cookie");
  return typeof value === "string" && value ? value : null;
}

/**
 * @param {import("http").IncomingMessage} req
 * @returns {boolean}
 */
export function requestHasAuthorization(req) {
  const value = headerValue(req, "authorization");
  return typeof value === "string" && value.length > 0;
}

/**
 * Stable request id: honor a short inbound `x-request-id` unless it equals
 * the bearer secret (never echo a token as the id).
 *
 * @param {import("http").IncomingMessage} req
 * @returns {string}
 */
export function resolveRequestId(req) {
  const incoming = headerValue(req, "x-request-id");
  const secret = bearerSecret(req);
  if (typeof incoming === "string") {
    const id = incoming.trim();
    if (id && id.length <= MAX_REQUEST_ID && !id.includes(" ") && id !== secret) {
      return id;
    }
  }
  return randomUUID();
}

/**
 * Record that the handler refused this request on its Origin check. The audit
 * row classifies `bad_origin` from this mark only, never by re-running the
 * predicate, so a route that does not enforce Origin (or a stateful predicate)
 * cannot relabel a response after the fact.
 *
 * @param {import("http").IncomingMessage} req
 */
export function markHttpAuditOriginRefused(req) {
  if (req && typeof req === "object") ORIGIN_REFUSED.add(req);
}

/**
 * Record that the handler refused this request on its Host check. The audit
 * row classifies `bad_host` from this mark only, never by re-running the
 * predicate.
 *
 * @param {import("http").IncomingMessage} req
 */
export function markHttpAuditHostRefused(req) {
  if (req && typeof req === "object") HOST_REFUSED.add(req);
}

/**
 * Whether the handler marked this request as an Origin refusal (DEV-861).
 *
 * @param {import("http").IncomingMessage} req
 * @returns {boolean}
 */
export function httpAuditOriginDenied(req) {
  return Boolean(req && ORIGIN_REFUSED.has(req));
}

/**
 * Whether the handler marked this request as a Host refusal (DEV-861).
 *
 * @param {import("http").IncomingMessage} req
 * @returns {boolean}
 */
export function httpAuditHostDenied(req) {
  return Boolean(req && HOST_REFUSED.has(req));
}

/**
 * Record the tenant a route resolved for this request so the row carries it
 * even when the identity object has no `tenant` field.
 *
 * @param {import("http").IncomingMessage} req
 * @param {string|null|undefined} tenant
 */
export function markHttpAuditTenant(req, tenant) {
  if (req && typeof req === "object" && typeof tenant === "string" && tenant) {
    TENANTS.set(req, tenant);
  }
}

/**
 * Classify a finished response into a closed denial code.
 *
 * Codes are mutually exclusive outcomes of the finished response. Host
 * and Origin denial only win on the 403 the handler actually emitted for
 * `/mcp`, and only when that handler marked the refusal on the request.
 *
 * @param {object} fields
 * @param {number} [fields.status]
 * @param {boolean} [fields.hasAuthorization]
 * @param {boolean} [fields.originDenied]
 * @param {boolean} [fields.hostDenied]
 * @param {boolean} [fields.aborted] Client went away before any status was written.
 * @returns {typeof HTTP_AUDIT_CODES[number]}
 */
export function classifyHttpAuditCode({
  status,
  hasAuthorization = false,
  originDenied = false,
  hostDenied = false,
  aborted = false,
} = {}) {
  if (aborted) return "aborted";
  const code = Number(status);
  if (code === 429) return "rate_limited";
  if (code === 401) return hasAuthorization ? "invalid_token" : "unauthenticated";
  if (hostDenied && code === 403) return "bad_host";
  if (originDenied && code === 403) return "bad_origin";
  if (Number.isFinite(code) && code >= 200 && code < 400) return "ok";
  return "forbidden";
}

/**
 * Drop forbidden keys and any string that equals a known secret.
 *
 * @param {object} row
 * @param {string[]} [secrets]
 * @returns {object}
 */
export function sanitizeHttpAuditRow(row, secrets = []) {
  const out = {};
  if (!row || typeof row !== "object") return out;
  const bag = new Map(Object.entries(row));
  for (const key of ["timestamp", "route", "method", "status", "code", "requestId", "principal", "tenant", "toolOutcome"]) {
    if (!bag.has(key)) continue;
    const folded = key.toLowerCase().replace(/_/g, "");
    if (FORBIDDEN_ROW_KEYS.has(folded)) continue;
    if (key === "timestamp") out.timestamp = bag.get(key);
    else if (key === "route") out.route = bag.get(key);
    else if (key === "method") out.method = bag.get(key);
    else if (key === "status") out.status = bag.get(key);
    else if (key === "code") out.code = bag.get(key);
    else if (key === "requestId") out.requestId = bag.get(key);
    else if (key === "principal") out.principal = bag.get(key);
    else if (key === "tenant") out.tenant = bag.get(key);
    else if (key === "toolOutcome" && TOOL_OUTCOMES.has(bag.get(key))) out.toolOutcome = bag.get(key);
  }
  if (!CODE_SET.has(out.code)) out.code = "forbidden";
  if (typeof out.status === "number") {
    // keep
  } else if (out.status !== undefined) {
    const n = Number(out.status);
    if (Number.isFinite(n)) out.status = n;
    else delete out.status;
  }
  let json;
  try {
    json = JSON.stringify(out);
  } catch {
    return { timestamp: out.timestamp, route: out.route, method: out.method, status: out.status, code: out.code, requestId: out.requestId };
  }
  for (const secret of secrets) {
    if (typeof secret === "string" && secret && json.includes(secret)) {
      json = json.split(secret).join("[redacted]");
    }
  }
  try {
    return JSON.parse(json);
  } catch {
    return { timestamp: out.timestamp, route: out.route, method: out.method, status: out.status, code: out.code, requestId: out.requestId };
  }
}

/**
 * Build one sanitized audit row from a finished request/response.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {object} [context]
 * @param {string} [context.requestId]
 * @param {boolean} [context.aborted] The client closed before a status was written.
 * @param {() => string} [context.now]
 * @returns {object}
 */
export function buildHttpAuditRow(req, res, {
  requestId,
  aborted = false,
  now = () => new Date().toISOString(),
} = {}) {
  const status = aborted ? 0 : Number(res?.statusCode);
  const originDenied = Boolean(req && ORIGIN_REFUSED.has(req));
  const hostDenied = Boolean(req && HOST_REFUSED.has(req));
  const identity = req?.mcpIdentity && typeof req.mcpIdentity === "object"
    ? req.mcpIdentity
    : null;
  const row = {
    timestamp: now(),
    route: String(req?.url || "").split("?")[0] || "/",
    method: String(req?.method || "GET").toUpperCase(),
    status: Number.isFinite(status) ? status : 0,
    code: classifyHttpAuditCode({
      status,
      hasAuthorization: requestHasAuthorization(req),
      originDenied,
      hostDenied,
      aborted,
    }),
    requestId: requestId || resolveRequestId(req),
  };
  const toolOutcome = req && TOOL_RESULTS.get(req);
  if (toolOutcome) row.toolOutcome = toolOutcome;
  const principal = identity?.sub || identity?.clientId;
  if (principal) row.principal = String(principal);
  const tenant = identity?.tenant || (req && TENANTS.get(req));
  if (tenant) row.tenant = String(tenant);
  return sanitizeHttpAuditRow(row, secretsFrom(req));
}

function secretsFrom(req) {
  return [bearerSecret(req), cookieSecret(req), headerValue(req, "proxy-authorization")]
    .filter((value) => typeof value === "string" && value);
}

/**
 * Create a fail-safe writer. `write` never throws to the caller.
 *
 * @param {object} [options]
 * @param {(row: object) => void} [options.sink]
 * @param {() => string} [options.now]
 * @returns {{write: (row: object, req?: object) => void, rows: object[]}}
 */
export function createHttpAuditWriter({
  sink = defaultHttpAuditSink,
  now = () => new Date().toISOString(),
} = {}) {
  const rows = [];

  function write(row, req) {
    try {
      const safe = sanitizeHttpAuditRow(
        { timestamp: now(), ...row },
        req ? secretsFrom(req) : [],
      );
      rows.push(safe);
      if (rows.length > MAX_BUFFERED_ROWS) rows.shift();
      if (typeof sink === "function") sink(safe);
    } catch {
      // Fail-safe: never surface a sink / serialize error.
    }
  }

  return { write, rows };
}

/**
 * Attach exactly one finish-time write to `res`. Idempotent. A write error
 * is swallowed so a refused request cannot become an allowed one. A `close`
 * before any status was written (client abort) is recorded as `aborted`
 * with status 0 rather than as the default 200.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {{write: Function}|null} writer
 * @param {object} [context]
 * @param {() => string} [context.now]
 */
export function attachHttpAudit(req, res, writer, context = {}) {
  if (!writer || typeof writer.write !== "function") return;
  if (!res || ATTACHED.has(res)) return;
  ATTACHED.add(res);
  const requestId = resolveRequestId(req);

  const writeOnce = ({ aborted = false } = {}) => {
    if (WRITTEN.has(res)) return;
    WRITTEN.add(res);
    try {
      writer.write(buildHttpAuditRow(req, res, { requestId, aborted, ...context }), req);
    } catch {
      // Fail-safe: the response has already been decided.
    }
  };
  const statusWritten = () => Boolean(res.headersSent || res.writableFinished);

  if (typeof res.on === "function") {
    res.on("finish", () => writeOnce());
    res.on("close", () => writeOnce({ aborted: !statusWritten() }));
    return;
  }

  // Test doubles without EventEmitter: wrap the terminal methods so a row
  // still lands. Production ServerResponse always exposes `on`.
  const origEnd = res.end;
  if (typeof origEnd === "function") {
    res.end = function auditedEnd(...args) {
      try {
        return origEnd.apply(this, args);
      } finally {
        writeOnce();
      }
    };
  }
  const origDestroy = res.destroy;
  if (typeof origDestroy === "function") {
    res.destroy = function auditedDestroy(...args) {
      const aborted = !statusWritten();
      try {
        return origDestroy.apply(this, args);
      } finally {
        writeOnce({ aborted });
      }
    };
  }
}
