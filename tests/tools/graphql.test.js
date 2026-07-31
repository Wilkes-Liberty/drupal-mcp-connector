import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/drupal-fetch.js", () => ({
  drupalGraphqlFetch: vi.fn(async () => ({ data: { ok: true } })),
}));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({
    _name: n || "d",
    baseUrl: "https://x",
    security: { preset: "production-strict" },
  })),
}));

import { getSiteConfig } from "../../src/lib/config.js";
import { drupalGraphqlFetch } from "../../src/lib/drupal-fetch.js";
import { handlers } from "../../src/tools/graphql.js";

beforeEach(() => {
  vi.mocked(drupalGraphqlFetch).mockClear();
  getSiteConfig.mockImplementation((n) => ({
    _name: n || "d",
    baseUrl: "https://x",
    security: { preset: "production-strict" },
  }));
});

describe("graphql tools policy (#142)", () => {
  it("refuses queries under production-strict", async () => {
    await expect(
      handlers.drupal_graphql({ query: "{ nodeArticles { nodes { id } } }" })
    ).rejects.toThrow(/allowGraphql/);
    expect(drupalGraphqlFetch).not.toHaveBeenCalled();
  });

  it("refuses introspect under production-strict", async () => {
    await expect(handlers.drupal_graphql_introspect({})).rejects.toThrow(/allowGraphql/);
    expect(drupalGraphqlFetch).not.toHaveBeenCalled();
  });

  it("allows queries when development preset is set", async () => {
    getSiteConfig.mockImplementation((n) => ({
      _name: n || "d",
      baseUrl: "https://x",
      security: { preset: "development" },
    }));
    const out = await handlers.drupal_graphql({ query: "{ __typename }" });
    expect(out.data).toEqual({ ok: true });
    expect(drupalGraphqlFetch).toHaveBeenCalled();
  });

  it("allows queries when allowGraphql is opted in on a strict preset", async () => {
    getSiteConfig.mockImplementation((n) => ({
      _name: n || "d",
      baseUrl: "https://x",
      security: { preset: "content-editor", allowGraphql: true },
    }));
    const out = await handlers.drupal_graphql({ query: "{ __typename }" });
    expect(out.data).toEqual({ ok: true });
  });
});
