/**
 * Process-local Prometheus metrics for the hosted HTTP surface (DEV-863).
 *
 * Closed label sets only: route (`/mcp`, `/health`, `/well-known`,
 * `/unknown`) and status, plus deny reason from the audit code list.
 * Counters never carry principals, subjects, client ids, tokens, tenants,
 * or IP addresses. Extra fields on `finishRequest` are ignored.
 */

import { classifyHttpAuditCode, requestHasAuthorization } from "./http-audit.js";

/** Closed route labels. Query strings and arbitrary paths never appear. */
export const METRICS_ROUTES = Object.freeze(["/mcp", "/health", "/well-known", "/unknown"]);

/**
 * Map a request path to a closed metrics route label.
 *
 * @param {unknown} path
 * @returns {(typeof METRICS_ROUTES)[number]}
 */
export function metricsRoute(path) {
  const raw = String(path || "").split("?")[0];
  if (raw === "/mcp") return "/mcp";
  if (raw === "/health") return "/health";
  if (raw === "/.well-known/oauth-protected-resource"
    || raw.startsWith("/.well-known/oauth-protected-resource/")) {
    return "/well-known";
  }
  return "/unknown";
}

/**
 * Closed fields recorded for one public request. Never copies a bearer,
 * identity, address, or header value.
 *
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {object} [marks]
 * @param {boolean} [marks.originDenied]
 * @param {boolean} [marks.hostDenied]
 * @returns {{path: string, status: number, hasAuthorization: boolean, originDenied: boolean, hostDenied: boolean}}
 */
export function publicRequestMetricFields(req, res, marks = {}) {
  return {
    path: String(req?.url || "").split("?")[0],
    status: res?.statusCode || 0,
    hasAuthorization: requestHasAuthorization(req),
    originDenied: Boolean(marks.originDenied),
    hostDenied: Boolean(marks.hostDenied),
  };
}

/**
 * @param {Map<string, number>} map
 * @param {string} key
 * @param {number} [delta]
 */
function bump(map, key, delta = 1) {
  map.set(key, (map.get(key) || 0) + delta);
}

/**
 * Create a metrics registry. Limiters are read only for the bucket gauge;
 * their keys (addresses / principals) are never copied into samples.
 *
 * @param {object} [options]
 * @param {?{size?: () => number}} [options.rateLimiter]
 * @param {?{size?: () => number}} [options.principalLimiter]
 * @returns {{
 *   beginRequest: () => void,
 *   finishRequest: (fields: object) => void,
 *   bucketsInUse: () => number,
 *   inFlight: () => number,
 *   render: () => string,
 * }}
 */
export function createOpsMetrics({
  rateLimiter = null,
  principalLimiter = null,
} = {}) {
  /** @type {Map<string, number>} */
  const requests = new Map();
  /** @type {Map<string, number>} */
  const denies = new Map();
  let unauthorized = 0;
  let forbidden = 0;
  let rateLimited = 0;
  let inFlight = 0;

  function bucketsInUse() {
    const address = typeof rateLimiter?.size === "function" ? rateLimiter.size() : 0;
    const principal = typeof principalLimiter?.size === "function" ? principalLimiter.size() : 0;
    return address + principal;
  }

  return {
    beginRequest() {
      inFlight += 1;
    },
    /**
     * Record one finished request. Only route, status, and deny marks
     * are read. Identity, tokens, tenants, and addresses are ignored.
     *
     * @param {object} fields
     * @param {unknown} [fields.path]
     * @param {unknown} [fields.status]
     * @param {boolean} [fields.hasAuthorization]
     * @param {boolean} [fields.originDenied]
     * @param {boolean} [fields.hostDenied]
     */
    finishRequest(fields = {}) {
      inFlight = Math.max(0, inFlight - 1);
      const route = metricsRoute(fields.path);
      const status = Number(fields.status);
      const statusLabel = Number.isFinite(status) && status > 0 ? String(status) : "0";
      bump(requests, `${route}\n${statusLabel}`);
      if (status === 401) unauthorized += 1;
      if (status === 403) forbidden += 1;
      if (status === 429) rateLimited += 1;
      const code = classifyHttpAuditCode({
        status,
        hasAuthorization: Boolean(fields.hasAuthorization),
        originDenied: Boolean(fields.originDenied),
        hostDenied: Boolean(fields.hostDenied),
      });
      if (code !== "ok" && code !== "aborted") bump(denies, code);
    },
    bucketsInUse,
    inFlight() {
      return inFlight;
    },
    render() {
      return renderPrometheus({
        requests,
        denies,
        unauthorized,
        forbidden,
        rateLimited,
        buckets: bucketsInUse(),
        inFlight,
      });
    },
  };
}

/**
 * Prometheus text (0.0.4). No HELP/TYPE line names an identity field.
 *
 * @param {object} snapshot
 * @returns {string}
 */
export function renderPrometheus(snapshot) {
  const lines = [
    "# HELP mcp_http_requests_total HTTP requests by route and status",
    "# TYPE mcp_http_requests_total counter",
  ];
  for (const [key, value] of snapshot.requests) {
    const [route, status] = key.split("\n");
    lines.push(`mcp_http_requests_total{route="${route}",status="${status}"} ${value}`);
  }
  lines.push(
    "# HELP mcp_http_denies_total HTTP denials by reason",
    "# TYPE mcp_http_denies_total counter",
  );
  for (const [reason, value] of snapshot.denies) {
    lines.push(`mcp_http_denies_total{reason="${reason}"} ${value}`);
  }
  lines.push(
    "# HELP mcp_http_unauthorized_total HTTP 401 responses",
    "# TYPE mcp_http_unauthorized_total counter",
    `mcp_http_unauthorized_total ${snapshot.unauthorized}`,
    "# HELP mcp_http_forbidden_total HTTP 403 responses",
    "# TYPE mcp_http_forbidden_total counter",
    `mcp_http_forbidden_total ${snapshot.forbidden}`,
    "# HELP mcp_http_rate_limited_total HTTP 429 responses",
    "# TYPE mcp_http_rate_limited_total counter",
    `mcp_http_rate_limited_total ${snapshot.rateLimited}`,
    "# HELP mcp_rate_limit_buckets Rate-limit buckets currently in use",
    "# TYPE mcp_rate_limit_buckets gauge",
    `mcp_rate_limit_buckets ${snapshot.buckets}`,
    "# HELP mcp_http_in_flight In-flight HTTP requests",
    "# TYPE mcp_http_in_flight gauge",
    `mcp_http_in_flight ${snapshot.inFlight}`,
  );
  return `${lines.join("\n")}\n`;
}
