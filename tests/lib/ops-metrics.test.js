/**
 * DEV-863: Prometheus samples never carry identity. Red evidence uses a
 * test-only fixture renderer, not a production toggle.
 */
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../../src/lib/rate-limit.js";
import {
  createOpsMetrics,
  metricsRoute,
  publicRequestMetricFields,
} from "../../src/lib/ops-metrics.js";

const LEAK_SUB = "agent-secret-sub";
const LEAK_CLIENT = "client-secret-id";
const LEAK_TENANT = "tenant-secret";
const LEAK_TOKEN = "tok_secret_value";
const LEAK_IP = "203.0.113.9";

const IDENTITY_LABEL = /\{[^}]*(principal|sub|client_id|clientId|tenant|ip|token)=/;

/**
 * @param {string} text
 */
function assertNoIdentity(text) {
  expect(text).not.toContain(LEAK_SUB);
  expect(text).not.toContain(LEAK_CLIENT);
  expect(text).not.toContain(LEAK_TENANT);
  expect(text).not.toContain(LEAK_TOKEN);
  expect(text).not.toContain(LEAK_IP);
  expect(text).not.toMatch(IDENTITY_LABEL);
  expect(text).not.toContain("mcp_debug_identity");
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
    assertNoIdentity(text);
  });

  it("publicRequestMetricFields never copies a bearer, identity, or address", () => {
    const fields = publicRequestMetricFields({
      url: "/mcp",
      headers: { authorization: `Bearer ${LEAK_TOKEN}` },
      mcpIdentity: { sub: LEAK_SUB, clientId: LEAK_CLIENT, tenant: LEAK_TENANT },
      socket: { remoteAddress: LEAK_IP },
    }, { statusCode: 401 }, {
      originDenied: false,
      hostDenied: false,
      identity: { sub: LEAK_SUB },
      authorization: `Bearer ${LEAK_TOKEN}`,
    });
    expect(fields).toEqual({
      path: "/mcp",
      status: 401,
      hasAuthorization: true,
      originDenied: false,
      hostDenied: false,
    });
    expect(JSON.stringify(fields)).not.toContain(LEAK_TOKEN);
    expect(JSON.stringify(fields)).not.toContain(LEAK_SUB);
    expect(JSON.stringify(fields)).not.toContain(LEAK_IP);
  });

  it("fails when a test-only fixture renderer leaks identity (red evidence)", () => {
    const leaked = `mcp_http_requests_total{sub="${LEAK_SUB}",client_id="${LEAK_CLIENT}",tenant="${LEAK_TENANT}",ip="${LEAK_IP}",token="${LEAK_TOKEN}"} 1\n`;
    expect(() => assertNoIdentity(leaked)).toThrow();
  });
});
