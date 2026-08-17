import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/lib/config.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    listSiteNames: vi.fn(() => ["prod", "open"]),
    getSiteConfig: vi.fn((name) => {
      if (name === "prod") {
        throw new Error(
          'Site "prod": requireSecureAuth is set but oauth.clientSecretEnv "MCP_AGENT_CLIENT_SECRET" is not set in the environment.',
        );
      }
      return { _name: name, baseUrl: "https://open.example.com" };
    }),
  };
});

vi.mock("../../src/lib/governance.js", () => ({
  governanceStatus: vi.fn(async (sites) => sites.map((site) => ({
    site: site._name,
    required: false,
    ok: true,
    reason: null,
    checkedAt: null,
  }))),
}));

import { getGovernanceStatus } from "../../src/tools/site.js";

describe("drupal_governance_status", () => {
  it("reports an unresolvable site instead of throwing", async () => {
    const result = await getGovernanceStatus();
    expect(result.sites).toEqual([
      {
        site: "prod",
        required: null,
        ok: false,
        reason: "credential_unresolved",
        detail: 'Site "prod": requireSecureAuth is set but oauth.clientSecretEnv "MCP_AGENT_CLIENT_SECRET" is not set in the environment.',
        checkedAt: null,
      },
      {
        site: "open",
        required: false,
        ok: true,
        reason: null,
        checkedAt: null,
      },
    ]);
  });
});
