import { describe, it, expect } from "vitest";
import { graphqlNodeToCanonical } from "../../src/lib/backends/graphql-normalize.js";

const node = {
  __typename: "NodeArticle",
  id: "b746da40-7bcc-4abe-9245-f15bcc776938",
  title: "Infrastructure-as-Code for Government",
  status: true,
  langcode: { id: "en" },
  created: { time: "2026-05-28T02:21:44+00:00" },
  changed: { time: "2026-05-28T02:21:46+00:00" },
  path: "/articles/iac-driven-infrastructure-for-government",
  body: { value: "<p>...</p>", summary: "", format: "full_html" },
  author: { __typename: "User", id: "user-1", name: "Jane" },
  tags: [{ __typename: "TermTags", id: "term-1", name: "DevOps" }],
};

describe("graphqlNodeToCanonical", () => {
  it("maps base fields from graphql_compose shapes", () => {
    const c = graphqlNodeToCanonical(node);
    expect(c.id).toBe("b746da40-7bcc-4abe-9245-f15bcc776938");
    expect(c.entityType).toBe("node");
    expect(c.bundle).toBe("article");
    expect(c.title).toBe("Infrastructure-as-Code for Government");
    expect(c.status).toBe(true);
    expect(c.langcode).toBe("en");
    expect(c.created).toBe("2026-05-28T02:21:44+00:00");
    expect(c.changed).toBe("2026-05-28T02:21:46+00:00");
    expect(c.url).toBe("/articles/iac-driven-infrastructure-for-government");
    expect(c._backend).toBe("graphql");
  });

  it("puts scalar/object non-base values in fields", () => {
    const c = graphqlNodeToCanonical(node);
    expect(c.fields.body).toEqual({ value: "<p>...</p>", summary: "", format: "full_html" });
    expect(c.fields).not.toHaveProperty("title");
    expect(c.fields).not.toHaveProperty("author");
    expect(c.fields).not.toHaveProperty("__typename");
  });

  it("normalizes nested entity refs (single + list) into relationships", () => {
    const c = graphqlNodeToCanonical(node);
    expect(c.relationships.author).toEqual({ id: "user-1", entityType: "user", bundle: "user" });
    expect(c.relationships.tags).toEqual([{ id: "term-1", entityType: "taxonomy_term", bundle: "tags" }]);
  });
});
