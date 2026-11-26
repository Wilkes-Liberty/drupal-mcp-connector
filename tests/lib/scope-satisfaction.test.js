/**
 * Exact-match scope satisfaction (DEV-1349).
 *
 * These rows fail on the #397 implication (`mcp_config` satisfies
 * `mcp_config_read`) and pass once satisfaction is exact match only.
 */

import { describe, expect, it } from "vitest";
import { grantedScopesSatisfy } from "../../src/lib/scope-satisfaction.js";
import { TOOL_SCOPE_TABLE } from "../../src/lib/tool-scopes.js";

const mappedScopes = [...new Set(
  Object.values(TOOL_SCOPE_TABLE).flatMap((row) => [...row.requiredScopes]),
)].sort();

describe("grantedScopesSatisfy (DEV-1349)", () => {
  it("lists every scope the connector maps", () => {
    expect(mappedScopes).toEqual([
      "mcp_admin",
      "mcp_config",
      "mcp_config_read",
      "mcp_read",
      "mcp_write",
    ]);
  });

  it.each(mappedScopes)("accepts an exact grant of %s and refuses every other mapped scope", (required) => {
    expect(grantedScopesSatisfy([required], required)).toBe(true);
    const others = mappedScopes.filter((scope) => scope !== required);
    expect(grantedScopesSatisfy(others, required)).toBe(false);
    for (const other of others) {
      expect(grantedScopesSatisfy([other], required)).toBe(false);
    }
  });

  it("refuses mcp_config for a read-only config requirement", () => {
    expect(grantedScopesSatisfy(["mcp_config"], "mcp_config_read")).toBe(false);
    expect(grantedScopesSatisfy(["mcp_config_read"], "mcp_config_read")).toBe(true);
    expect(grantedScopesSatisfy(["mcp_config"], "mcp_config")).toBe(true);
    expect(grantedScopesSatisfy(["mcp_config_read"], "mcp_config")).toBe(false);
  });

  it("treats a missing requirement as unrestricted and an empty grant as no match", () => {
    expect(grantedScopesSatisfy([], null)).toBe(true);
    expect(grantedScopesSatisfy(undefined, "")).toBe(true);
    expect(grantedScopesSatisfy([], "mcp_read")).toBe(false);
    expect(grantedScopesSatisfy(null, "mcp_read")).toBe(false);
  });
});
