import { describe, it, expect } from "vitest";
import { buildSelection, buildCollectionQuery, buildSingleQuery } from "../../src/lib/backends/graphql-query.js";

function fieldsMap(obj) {
  return new Map(Object.entries(obj));
}

const entry = {
  typeName: "NodeArticle",
  single: "nodeArticle",
  collection: "nodeArticles",
  fields: fieldsMap({
    id: { kind: "SCALAR", typeName: "ID" },
    title: { kind: "SCALAR", typeName: "String" },
    status: { kind: "SCALAR", typeName: "Boolean" },
    langcode: { kind: "OBJECT", typeName: "Language" },
    created: { kind: "OBJECT", typeName: "DateTime" },
    body: { kind: "OBJECT", typeName: "TextSummary" },
    author: { kind: "OBJECT", typeName: "User" },
    tags: { kind: "LIST", ofTypeKind: "UNION", ofTypeName: "TermUnion" },
    heroImage: { kind: "UNION", typeName: "MediaUnion" },
    metatag: { kind: "LIST", ofTypeKind: "UNION", ofTypeName: "MetaTagUnion" },
  }),
};

describe("buildSelection", () => {
  it("selects scalars bare and sub-selects known objects", () => {
    const sel = buildSelection(entry);
    expect(sel).toContain("title");
    expect(sel).toContain("status");
    expect(sel).toContain("langcode { id }");
    expect(sel).toContain("created { time }");
    expect(sel).toContain("body { value summary format }");
  });

  it("treats entity-ref objects as relationships", () => {
    const sel = buildSelection(entry);
    expect(sel).toContain("author { __typename id }");
  });

  it("expands union lists with an inline fragment on the interface", () => {
    const sel = buildSelection(entry);
    expect(sel).toContain("tags { __typename ... on TermInterface { __typename id } }");
  });

  it("selects a single entity union (MediaUnion) as a relationship ref", () => {
    const sel = buildSelection(entry);
    expect(sel).toContain("heroImage { __typename ... on MediaInterface { __typename id } }");
  });

  it("skips non-entity union lists (e.g. metatag/MetaTagUnion) to keep the query valid", () => {
    const sel = buildSelection(entry);
    expect(sel).not.toContain("metatag");
    expect(sel).not.toContain("MetaTagInterface");
  });

  it("always includes __typename and id", () => {
    const sel = buildSelection(entry);
    expect(sel).toContain("__typename");
    expect(sel.trim().startsWith("__typename")).toBe(true);
  });
});

describe("buildCollectionQuery", () => {
  it("emits the collection field with pagination and sortKey args", () => {
    const q = buildCollectionQuery(entry, { first: 10, after: "CUR", sortKey: "CREATED_AT", reverse: true });
    expect(q).toContain("nodeArticles(first: 10, after: \"CUR\", sortKey: CREATED_AT, reverse: true)");
    expect(q).toContain("pageInfo { hasNextPage endCursor }");
    expect(q).toContain("nodes {");
  });

  it("omits args that are not provided", () => {
    const q = buildCollectionQuery(entry, { first: 5 });
    expect(q).toContain("nodeArticles(first: 5)");
    expect(q).not.toContain("after");
    expect(q).not.toContain("sortKey");
  });
});

describe("buildSingleQuery", () => {
  it("emits the single field with an id arg", () => {
    const q = buildSingleQuery(entry, "uuid-1");
    expect(q).toContain("nodeArticle(id: \"uuid-1\")");
    expect(q).toContain("__typename");
  });
});
