/**
 * DEV-862: deny-by-default tool scope table.
 *
 * These assertions are written to fail on master (no explicit table, unknown
 * tools default to mcp_read, empty requiredScopes is unrestricted) and pass
 * once the hosted/network gate is in place.
 */

import { describe, expect, it } from "vitest";
import { allDefinitions } from "../../src/tools/index.js";
import {
  EMPTY_REQUIRED_SCOPES_REASON,
  MISSING_SCOPE_ENTRY_REASON,
  TOOL_SCOPE_TABLE,
  assertHostedToolScopeTable,
  networkToolScopeDenial,
  requiredScopesForTool,
} from "../../src/lib/tool-scopes.js";

describe("TOOL_SCOPE_TABLE registry coverage (DEV-862)", () => {
  it("fails if any registered tool lacks a scope-table entry", () => {
    const missing = allDefinitions
      .map((definition) => definition.name)
      .filter((name) => !TOOL_SCOPE_TABLE[name]);
    expect(missing, `tools missing from TOOL_SCOPE_TABLE: ${missing.join(", ")}`).toEqual([]);
  });

  it("fails if any registered tool has empty requiredScopes", () => {
    const empty = allDefinitions
      .map((definition) => definition.name)
      .filter((name) => {
        const scopes = requiredScopesForTool(name);
        return !scopes || scopes.length === 0;
      });
    expect(empty, `tools with empty requiredScopes: ${empty.join(", ")}`).toEqual([]);
  });
});

describe("assertHostedToolScopeTable (DEV-862)", () => {
  it("accepts the live registry against the committed table", () => {
    expect(() => assertHostedToolScopeTable(allDefinitions)).not.toThrow();
  });

  it("is fatal on a hosted/network profile when a registered tool has empty requiredScopes", () => {
    expect(() => assertHostedToolScopeTable(
      [{ name: "drupal_get_node" }, { name: "drupal_probe_empty" }],
      {
        drupal_get_node: { requiredScopes: ["mcp_read"] },
        drupal_probe_empty: { requiredScopes: [] },
      },
    )).toThrow(new RegExp(`${EMPTY_REQUIRED_SCOPES_REASON}.*drupal_probe_empty`));
  });

  it("is fatal on a hosted/network profile when a registered tool has no table entry", () => {
    expect(() => assertHostedToolScopeTable(
      [{ name: "drupal_get_node" }, { name: "drupal_probe_missing" }],
      { drupal_get_node: { requiredScopes: ["mcp_read"] } },
    )).toThrow(new RegExp(`${MISSING_SCOPE_ENTRY_REASON}.*drupal_probe_missing`));
  });
});

describe("networkToolScopeDenial (DEV-862)", () => {
  it("names a missing entry and an empty requiredScopes row", () => {
    expect(networkToolScopeDenial("drupal_eval_unscoped")).toMatch(/not in the scope table/i);
    expect(networkToolScopeDenial("drupal_get_node")).toBeNull();
  });
});
