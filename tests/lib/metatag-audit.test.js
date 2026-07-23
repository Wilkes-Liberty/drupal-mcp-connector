import { describe, it, expect, vi, beforeEach } from "vitest";

const graphqlFetch = vi.fn();
vi.mock("../../src/lib/drupal-fetch.js", () => ({
  drupalGraphqlFetch: (...args) => graphqlFetch(...args),
}));

import { metaDescriptionFromMetatag, fetchRenderedMetaDescriptions } from "../../src/lib/metatag-audit.js";

beforeEach(() => graphqlFetch.mockReset());

describe("metaDescriptionFromMetatag", () => {
  it("returns the trimmed description content", () => {
    const metatag = [
      { __typename: "MetaTagValue", attributes: { name: "title", content: "T" } },
      { __typename: "MetaTagValue", attributes: { name: "description", content: "  hello world  " } },
      { __typename: "MetaTagLink", attributes: { rel: "canonical", href: "/x" } },
    ];
    expect(metaDescriptionFromMetatag(metatag)).toBe("hello world");
  });

  it("returns '' when there is no description tag", () => {
    expect(metaDescriptionFromMetatag([{ __typename: "MetaTagValue", attributes: { name: "title", content: "T" } }])).toBe("");
  });

  it("returns '' for a non-array or empty input", () => {
    expect(metaDescriptionFromMetatag(null)).toBe("");
    expect(metaDescriptionFromMetatag([])).toBe("");
  });
});

describe("fetchRenderedMetaDescriptions", () => {
  const site = { baseUrl: "https://x" };

  it("is unavailable (without calling GraphQL) when no node has a path alias", async () => {
    const res = await fetchRenderedMetaDescriptions(site, [{ id: "n1" }, { id: "n2", url: null }]);
    expect(res.source).toBe("unavailable");
    expect(graphqlFetch).not.toHaveBeenCalled();
  });

  it("resolves descriptions from the rendered metatag", async () => {
    graphqlFetch.mockResolvedValue({
      data: {
        n0: { entity: { metatag: [{ __typename: "MetaTagValue", attributes: { name: "description", content: "has desc" } }] } },
        n1: { entity: { metatag: [{ __typename: "MetaTagValue", attributes: { name: "title", content: "only title" } }] } },
      },
    });
    const res = await fetchRenderedMetaDescriptions(site, [
      { id: "a", url: "/a" },
      { id: "b", url: "/b" },
    ]);
    expect(res.source).toBe("graphql");
    expect(res.byId.get("a")).toEqual({ description: "has desc" });
    expect(res.byId.get("b")).toEqual({ description: "" });
  });

  it("skips nodes whose route does not resolve (leaves them unknown)", async () => {
    graphqlFetch.mockResolvedValue({ data: { n0: null } });
    const res = await fetchRenderedMetaDescriptions(site, [{ id: "a", url: "/a" }]);
    expect(res.source).toBe("graphql");
    expect(res.byId.has("a")).toBe(false);
  });

  it("is unavailable on a GraphQL schema error (no metatag / graphql_compose_metatags)", async () => {
    graphqlFetch.mockResolvedValue({ errors: [{ message: "Cannot query field \"metatag\"" }] });
    const res = await fetchRenderedMetaDescriptions(site, [{ id: "a", url: "/a" }]);
    expect(res.source).toBe("unavailable");
    expect(res.reason).toContain("metatag");
  });

  it("is unavailable when the GraphQL request throws", async () => {
    graphqlFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await fetchRenderedMetaDescriptions(site, [{ id: "a", url: "/a" }]);
    expect(res.source).toBe("unavailable");
    expect(res.reason).toContain("ECONNREFUSED");
  });

  it("batches large samples into multiple requests", async () => {
    graphqlFetch.mockResolvedValue({ data: {} });
    const entities = Array.from({ length: 26 }, (_, i) => ({ id: `n${i}`, url: `/n${i}` }));
    await fetchRenderedMetaDescriptions(site, entities);
    expect(graphqlFetch).toHaveBeenCalledTimes(2); // CHUNK = 25
  });
});
