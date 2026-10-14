/**
 * Process-local Prometheus metrics for the hosted HTTP surface (DEV-863).
 *
 * Closed label sets only: route (`/mcp`, `/health`, `/well-known`,
 * `/unknown`) and status, plus deny reason from the audit code list.
 * Counters never carry principals, subjects, client ids, tokens, tenants,
 * or IP addresses. A test-only guard can reintroduce those labels so the
 * leak assertion can go red.
 */

import { classifyHttpAuditCode } from "./http-audit.js";

/**
 * Test-only guard (DEV-863). Production callers never flip this. When
 * `required` is false, render includes identity labels — the leak used
 * to prove the no-identity test can fail.
 *
 * @type {{required: boolean}}
 */
export const OPS_METRICS_IDENTITY_GUARD = { required: true };

/**
 * Flip {@link OPS_METRICS_IDENTITY_GUARD} for a red-run. Restore `true`
 * after the assertion; production code never calls this.
 *
 * @param {boolean} required
 * @returns {void}
 */
export function setOpsMetricsIdentityGuard(required) {
  OPS_METRICS_IDENTITY_GUARD.required = Boolean(required);
}

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
  /** @type {object|null} */
  let leakedIdentity = null;

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
     * Record one finished request. Identity fields are accepted so a
     * disabled guard can leak them; production render ignores them.
     *
     * @param {object} fields
     * @param {unknown} [fields.path]
     * @param {unknown} [fields.status]
     * @param {boolean} [fields.hasAuthorization]
     * @param {boolean} [fields.originDenied]
     * @param {boolean} [fields.hostDenied]
     * @param {object|null} [fields.identity]
     * @param {unknown} [fields.address]
     * @param {unknown} [fields.authorization]
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
      if (!OPS_METRICS_IDENTITY_GUARD.required) {
        leakedIdentity = {
          sub: fields.identity?.sub,
          clientId: fields.identity?.clientId,
          tenant: fields.identity?.tenant,
          ip: fields.address,
          token: fields.authorization,
        };
      }
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
        leakedIdentity: OPS_METRICS_IDENTITY_GUARD.required ? null : leakedIdentity,
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
  if (snapshot.leakedIdentity) {
    const leak = snapshot.leakedIdentity;
    lines.push(
      `mcp_debug_identity{sub="${leak.sub ?? ""}",client_id="${leak.clientId ?? ""}",tenant="${leak.tenant ?? ""}",ip="${leak.ip ?? ""}",token="${leak.token ?? ""}"} 1`,
    );
  }
  return `${lines.join("\n")}\n`;
}
