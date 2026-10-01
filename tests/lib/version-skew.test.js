import { describe, it, expect } from "vitest";
import {
  compareSemver,
  detectVersionSkew,
  extractReportedVersions,
  versionSkewCheck,
  SENTINEL_MIN_FOR_CONTRACT,
} from "../../src/lib/version-skew.js";

describe("version skew (DEV-766)", () => {
  it("compares dotted versions", () => {
    expect(compareSemver("2.9.0", "2.8.9")).toBe(1);
    expect(compareSemver("2.1.0", SENTINEL_MIN_FOR_CONTRACT)).toBe(-1);
    expect(compareSemver("2.24.2", "2.24.2")).toBe(0);
  });

  it("extracts versions from body and headers", () => {
    const reported = extractReportedVersions(
      { versions: { sentinel: "2.10.0" }, min_connector_version: "2.20.0" },
      { get: (name) => (name === "x-mcp-connector-version" ? "2.24.2" : null) },
    );
    expect(reported.sentinelVersion).toBe("2.10.0");
    expect(reported.minConnectorVersion).toBe("2.20.0");
    expect(reported.siteConnectorVersion).toBe("2.24.2");
  });

  it("skips when the site reports nothing", () => {
    const report = detectVersionSkew({}, "2.24.2");
    expect(report.detectable).toBe(false);
    expect(report.skew).toBe(false);
    expect(versionSkewCheck(report).status).toBe("skipped");
  });

  it("fails when the connector is below the site's minimum", () => {
    const report = detectVersionSkew({ minConnectorVersion: "3.0.0" }, "2.24.2");
    expect(report.skew).toBe(true);
    expect(report.detail).toMatch(/You are on connector 2\.24\.2/);
    expect(report.siteNeeds).toMatch(/3\.0\.0/);
    expect(report.nextFix).toMatch(/never auto-upgrade/);
    expect(versionSkewCheck(report).status).toBe("fail");
  });

  it("fails when Sentinel is below the contract floor", () => {
    const report = detectVersionSkew({ sentinelVersion: "1.14.0" }, "2.24.2");
    expect(report.skew).toBe(true);
    expect(report.siteNeeds).toMatch(SENTINEL_MIN_FOR_CONTRACT);
  });

  it("passes when reported versions are compatible", () => {
    const report = detectVersionSkew({
      sentinelVersion: "2.24.0",
      siteConnectorVersion: "2.24.2",
    }, "2.24.2");
    expect(report.skew).toBe(false);
    expect(report.detectable).toBe(true);
    expect(versionSkewCheck(report).status).toBe("pass");
  });
});
