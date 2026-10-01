import { describe, it, expect } from "vitest";
import {
  DOCTOR_CHECK_IDS,
  runDoctor,
  formatDoctorReport,
  secretValuesFromSite,
  scrubSecrets,
} from "../../src/lib/doctor.js";

const SECRET = "super-secret-token-value-xyz";

/**
 * @param {number} status
 * @param {object} [body]
 * @param {Record<string, string>} [headers]
 */
function reply(status, body = {}, headers = {}) {
  return {
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

/**
 * @param {object} routes url suffix → response or throw
 */
function fetchMap(routes) {
  return async (url) => {
    const key = String(url);
    for (const [suffix, value] of Object.entries(routes)) {
      if (key.endsWith(suffix) || key === suffix) {
        if (typeof value === "function") return value();
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

const liveSite = (over = {}) => ({
  _name: "staging",
  baseUrl: "https://cms.staging.internal",
  requireGovernance: true,
  apiToken: SECRET,
  security: { preset: "production-strict" },
  ...over,
});

describe("doctor gate order", () => {
  it("lists checks in the required order", () => {
    expect(DOCTOR_CHECK_IDS).toEqual([
      "reachability",
      "auth",
      "agent_client",
      "allowlist",
      "readiness",
      "version_skew",
    ]);
  });

  it("reports reachability as the primary failure and skips later live gates", async () => {
    const report = await runDoctor({
      site: liveSite(),
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      connectorVersion: "2.24.2",
    });
    expect(report.checks.map((c) => c.id)).toEqual(DOCTOR_CHECK_IDS);
    expect(report.primaryFailure.id).toBe("reachability");
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === "auth").status).toBe("skipped");
    expect(report.checks.find((c) => c.id === "readiness").status).toBe("skipped");
    expect(formatDoctorReport(report)).toMatch(/PRIMARY FAILURE: reachability/);
    expect(formatDoctorReport(report)).toMatch(/NEXT FIX:/);
  });

  it("does not probe documentation-reserved hosts", async () => {
    let called = 0;
    const report = await runDoctor({
      args: { host: "https://drupal.example.com" },
      env: {},
      fetch: async () => {
        called += 1;
        throw new Error("should not fetch");
      },
    });
    expect(called).toBe(0);
    expect(report.primaryFailure.id).toBe("reachability");
    expect(report.primaryFailure.detail).toMatch(/Documentation-reserved/);
  });

  it("makes auth 401 the primary failure when the host responds", async () => {
    const report = await runDoctor({
      site: liveSite(),
      fetch: fetchMap({
        "/jsonapi": reply(401, { errors: [{ status: "401" }] }),
      }),
    });
    expect(report.primaryFailure.id).toBe("auth");
    expect(report.primaryFailure.nextFix).toMatch(/sealed token|OAuth/i);
    expect(report.checks.find((c) => c.id === "reachability").status).toBe("pass");
  });

  it("fails allowlist when allowedEntityTypes is empty", async () => {
    const report = await runDoctor({
      site: liveSite({
        security: { preset: "production-strict", allowedEntityTypes: [] },
      }),
      fetch: fetchMap({
        "/jsonapi": reply(200, { jsonapi: { version: "1.0" } }),
        "/drupal-mcp/readiness": reply(200, { contract_ready: true }),
      }),
    });
    expect(report.primaryFailure.id).toBe("allowlist");
    expect(report.primaryFailure.nextFix).toMatch(/will not widen/);
  });

  it("promotes designated_consumer_missing onto agent_client and readiness", async () => {
    const report = await runDoctor({
      site: liveSite(),
      args: { "client-id": "cursor-local" },
      fetch: fetchMap({
        "/jsonapi": reply(200, { jsonapi: { version: "1.0" } }),
        "/drupal-mcp/readiness": reply(200, {
          contract_ready: false,
          reason: "designated_consumer_missing",
        }),
      }),
    });
    expect(report.checks.find((c) => c.id === "agent_client").status).toBe("fail");
    expect(report.primaryFailure.id).toBe("agent_client");
    expect(report.primaryFailure.nextFix).toMatch(/Register this agent client/);
  });

  it("fails version skew when Sentinel is below the contract floor", async () => {
    const report = await runDoctor({
      site: liveSite(),
      connectorVersion: "2.24.2",
      fetch: fetchMap({
        "/jsonapi": reply(200, { jsonapi: { version: "1.0" } }),
        "/drupal-mcp/readiness": reply(200, {
          contract_ready: true,
          sentinel_version: "2.1.0",
        }),
      }),
    });
    expect(report.primaryFailure.id).toBe("version_skew");
    expect(report.primaryFailure.detail).toMatch(/You are on connector 2\.24\.2/);
    expect(report.primaryFailure.detail).toMatch(/2\.1\.0/);
    expect(report.primaryFailure.nextFix).toMatch(/never auto-upgrade/);
  });

  it("passes when every live gate is green and versions are absent", async () => {
    const report = await runDoctor({
      site: liveSite(),
      fetch: fetchMap({
        "/jsonapi": reply(200, { jsonapi: { version: "1.0" } }),
        "/drupal-mcp/readiness": reply(200, { contract_ready: true }),
      }),
    });
    expect(report.ok).toBe(true);
    expect(report.primaryFailure).toBeNull();
    expect(report.checks.find((c) => c.id === "version_skew").status).toBe("skipped");
    expect(formatDoctorReport(report)).toMatch(/drupal_mcp_whoami/);
  });

  it("never leaks secrets into the report or human text", async () => {
    const report = await runDoctor({
      site: liveSite(),
      fetch: fetchMap({
        "/jsonapi": reply(401, { errors: [{ detail: SECRET }] }),
      }),
    });
    const blob = `${JSON.stringify(report)}\n${formatDoctorReport(report)}`;
    expect(blob).not.toContain(SECRET);
    expect(scrubSecrets({ token: SECRET }, secretValuesFromSite(liveSite())).token).toBe("[redacted]");
  });
});
