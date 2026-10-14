/**
 * DEV-863: Prometheus samples never carry identity. The identity guard
 * can be flipped so this assertion goes red.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRateLimiter } from "../../src/lib/rate-limit.js";
import {
  createOpsMetrics,
  metricsRoute,
  OPS_METRICS_IDENTITY_GUARD,
  setOpsMetricsIdentityGuard,
} from "../../src/lib/ops-metrics.js";

const LEAK_SUB = "agent-secret-sub";
const LEAK_CLIENT = "client-secret-id";
const LEAK_TENANT = "tenant-secret";
const LEAK_TOKEN = "tok_secret_value";
const LEAK_IP = "203.0.113.9";

const IDENTITY_LABEL = /\{[^}]*(principal|sub|client_id|clientId|tenant|ip|token)=/;

function recordLeakedRequest(metrics) {
  metrics.beginRequest();
  metrics.finishRequest({
    path: "/mcp?access_token=tok_secret_value",
    status: 401,
    hasAuthorization: true,
    identity: { sub: LEAK_SUB, clientId: LEAK_CLIENT, tenant: LEAK_TENANT },
    address: LEAK_IP,
    authorization: `Bearer ${LEAK_TOKEN}`,
  });
}

describe("metricsRoute", () => {
  it("folds paths to a closed label set", () => {
    expect(metricsRoute("/mcp")).toBe("/mcp");
    expect(metricsRoute("/health?ready=1")).toBe("/health");
    expect(metricsRoute("/.well-known/oauth-protected-resource/mcp")).toBe("/well-known");
    expect(metricsRoute("/ready")).toBe("/unknown");
    expect(metricsRoute("/metrics")).toBe("/unknown");
    expect(metricsRoute("/nope?sub=agent-secret-sub")).toBe("/unknown");
  });
});

describe("no identity in metrics (DEV-863)", () => {
  afterEach(() => {
    setOpsMetricsIdentityGuard(true);
  });

  it("counts route/status, denies, 401/403/429, buckets, and in-flight without identity", () => {
    const rateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
    rateLimiter.check("addr:203.0.113.9");
    const metrics = createOpsMetrics({ rateLimiter, principalLimiter: null });
    expect(metrics.inFlight()).toBe(0);
    metrics.beginRequest();
    expect(metrics.inFlight()).toBe(1);
    metrics.finishRequest({
      path: "/mcp",
      status: 401,
      hasAuthorization: false,
      identity: { sub: LEAK_SUB, clientId: LEAK_CLIENT, tenant: LEAK_TENANT },
      address: LEAK_IP,
      authorization: `Bearer ${LEAK_TOKEN}`,
    });
    metrics.beginRequest();
    metrics.finishRequest({ path: "/mcp", status: 403, originDenied: true });
    metrics.beginRequest();
    metrics.finishRequest({ path: "/mcp", status: 429 });
    metrics.beginRequest();
    metrics.finishRequest({ path: "/health", status: 200 });

    const text = metrics.render();
    expect(text).toContain("mcp_http_requests_total{route=\"/mcp\",status=\"401\"} 1");
    expect(text).toContain("mcp_http_requests_total{route=\"/mcp\",status=\"403\"} 1");
    expect(text).toContain("mcp_http_requests_total{route=\"/mcp\",status=\"429\"} 1");
    expect(text).toContain("mcp_http_requests_total{route=\"/health\",status=\"200\"} 1");
    expect(text).toContain("mcp_http_denies_total{reason=\"unauthenticated\"} 1");
    expect(text).toContain("mcp_http_denies_total{reason=\"bad_origin\"} 1");
    expect(text).toContain("mcp_http_denies_total{reason=\"rate_limited\"} 1");
    expect(text).toContain("mcp_http_unauthorized_total 1");
    expect(text).toContain("mcp_http_forbidden_total 1");
    expect(text).toContain("mcp_http_rate_limited_total 1");
    expect(text).toMatch(/mcp_rate_limit_buckets 1/);
    expect(text).toContain("mcp_http_in_flight 0");
    expect(metrics.bucketsInUse()).toBe(1);

    expect(text).not.toContain(LEAK_SUB);
    expect(text).not.toContain(LEAK_CLIENT);
    expect(text).not.toContain(LEAK_TENANT);
    expect(text).not.toContain(LEAK_TOKEN);
    expect(text).not.toContain(LEAK_IP);
    expect(text).not.toMatch(IDENTITY_LABEL);
    expect(text).not.toContain("mcp_debug_identity");
  });

  it("fails when the identity guard is disabled (red evidence)", () => {
    expect(OPS_METRICS_IDENTITY_GUARD.required).toBe(true);
    const metrics = createOpsMetrics();
    setOpsMetricsIdentityGuard(false);
    recordLeakedRequest(metrics);
    const text = metrics.render();
    expect(text).toContain(LEAK_SUB);
    expect(text).toContain(LEAK_CLIENT);
    expect(text).toContain(LEAK_TENANT);
    expect(text).toContain(LEAK_IP);
    expect(text).toMatch(IDENTITY_LABEL);
  });
});
