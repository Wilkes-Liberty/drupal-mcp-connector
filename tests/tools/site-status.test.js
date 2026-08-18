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
    checked: true,
    ok: true,
    reason: null,
    checkedAt: 1,
  }))),
}));

import { getGovernanceStatus, classifySiteResolutionFailure } from "../../src/tools/site.js";

describe("classifySiteResolutionFailure", () => {
  it("does not call every getSiteConfig failure a missing secret", () => {
    expect(classifySiteResolutionFailure('Unknown site: "nope". Configured sites: prod')).toBe("unknown_site");
    expect(classifySiteResolutionFailure('Site "dev": requireSecureAuth is set but baseUrl is not HTTPS.')).toBe("insecure_base_url");
    expect(classifySiteResolutionFailure('Site "prod": requireSecureAuth is set but oauth.clientSecretEnv "X" is not set in the environment.')).toBe("credential_unresolved");
    expect(classifySiteResolutionFailure("something else")).toBe("site_unresolved");
  });
});

describe("drupal_governance_status", () => {
  it("reports an unresolvable site instead of throwing", async () => {
    const result = await getGovernanceStatus();
    expect(result.sites).toEqual([
      {
        site: "prod",
        required: null,
        checked: false,
        ok: false,
        reason: "credential_unresolved",
        detail: 'Site "prod": requireSecureAuth is set but oauth.clientSecretEnv "MCP_AGENT_CLIENT_SECRET" is not set in the environment.',
      },
      {
        site: "open",
        required: false,
        checked: true,
        ok: true,
        reason: null,
        checkedAt: 1,
      },
    ]);
  });
});
