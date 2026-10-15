import { describe, expect, it } from "vitest";
import {
  assertStagingReadOnly,
  missingStagingTokens,
  readStagingConfig,
  STAGING_ENV,
  STAGING_SKIP_REASON,
} from "./staging.js";

describe("staging pack mode", () => {
  it("is unset (skip) when the base URL or issuer is missing", () => {
    expect(readStagingConfig({})).toBeNull();
    expect(readStagingConfig({ [STAGING_ENV.baseUrl]: "https://mcp.staging.example/mcp" })).toBeNull();
    expect(readStagingConfig({ [STAGING_ENV.issuer]: "https://paladin.staging.example" })).toBeNull();
    expect(STAGING_SKIP_REASON).toMatch(/skipped/);
  });

  it("reads the configured endpoint and names missing tokens", () => {
    const config = readStagingConfig({
      [STAGING_ENV.baseUrl]: "https://mcp.staging.example/mcp/",
      [STAGING_ENV.issuer]: "https://paladin.staging.example",
      [STAGING_ENV.tokenRead]: "read-token",
    });
    expect(config.baseUrl).toBe("https://mcp.staging.example/mcp");
    expect(config.issuer).toBe("https://paladin.staging.example");
    expect(missingStagingTokens(config)).toEqual([
      STAGING_ENV.tokenWrongAudience,
      STAGING_ENV.tokenExpired,
      STAGING_ENV.tokenInsufficientScope,
      STAGING_ENV.tokenNonMember,
    ]);
  });

  it("refuses write-shaped tool calls", () => {
    expect(() => assertStagingReadOnly({
      headers: { "mcp-name": "drupal_create_node" },
      body: "",
    })).toThrow(/read-only/);
    expect(() => assertStagingReadOnly({
      headers: {},
      body: JSON.stringify({ method: "tools/call", params: { name: "drupal_delete_node" } }),
    })).toThrow(/read-only/);
    expect(() => assertStagingReadOnly({
      headers: { "mcp-name": "drupal_list_nodes" },
      body: JSON.stringify({ method: "tools/list" }),
    })).not.toThrow();
  });
});
