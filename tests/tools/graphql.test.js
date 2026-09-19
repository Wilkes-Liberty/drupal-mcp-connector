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

describe("GraphQL errors on a 200 response (#356)", () => {
  const dev = (n) => ({ _name: n || "d", baseUrl: "https://x", security: { preset: "development" } });
  const hostile = "<b>x</b> in /var/www/html/web/modules/custom/a.module " + "y".repeat(20000);

  beforeEach(() => getSiteConfig.mockImplementation(dev));

  it("drupal_graphql throws a cleaned, bounded message when there is no data", async () => {
    drupalGraphqlFetch.mockResolvedValueOnce({ data: null, errors: [{ message: hostile }, { message: "second" }] });
    const err = await handlers.drupal_graphql({ query: "{ a }" }).catch((e) => e);
    expect(err.message.startsWith("GraphQL errors: x in [path] yyy")).toBe(true);
    expect(err.message).not.toMatch(/[<>]|var\/www/);
    expect(err.message.length).toBeLessThan(1300);
    expect(err.message).toContain("second");
  });

  it("drupal_graphql returns data untouched with cleaned, bounded warnings", async () => {
    const data = { a: "<b>kept</b> /var/www/html/x" };
    drupalGraphqlFetch.mockResolvedValueOnce({
      data,
      errors: [{ message: hostile }, ...Array.from({ length: 500 }, (_, i) => ({ message: `e${i}` }))],
    });
    const out = await handlers.drupal_graphql({ query: "{ a }" });
    expect(out.data).toEqual(data);
    expect(out.warnings.length).toBeLessThanOrEqual(51);
    expect(out.warnings[0]).not.toMatch(/[<>]|var\/www/);
    expect(out.warnings[0].length).toBeLessThan(500);
    expect(out.warnings.at(-1)).toMatch(/more errors not shown$/);
  });

  it("drupal_graphql_introspect throws a cleaned, bounded message for the overview", async () => {
    drupalGraphqlFetch.mockResolvedValueOnce({ data: null, errors: [{ message: hostile }] });
    const err = await handlers.drupal_graphql_introspect({}).catch((e) => e);
    expect(err.message.startsWith("x in [path] yyy")).toBe(true);
    expect(err.message.length).toBeLessThan(1300);
  });

  it("drupal_graphql_introspect reports the errors of a failed type lookup, not a missing type", async () => {
    drupalGraphqlFetch.mockResolvedValueOnce({ data: null, errors: [{ message: "Introspection is disabled in /var/www/html/web/sites/default/services.yml" }] });
    await expect(handlers.drupal_graphql_introspect({ typeName: "NodeArticle" }))
      .rejects.toThrow("Introspection is disabled in [path]");

    drupalGraphqlFetch.mockResolvedValueOnce({ data: { __type: null } });
    await expect(handlers.drupal_graphql_introspect({ typeName: "Nope" })).rejects.toThrow("Type 'Nope' not found in schema.");
  });
});
