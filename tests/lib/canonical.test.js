import { describe, it, expect } from "vitest";
import {
  BASE_ATTRIBUTE_FIELDS,
  makeCanonicalEntity,
  normalizeRelationship,
} from "../../src/lib/canonical.js";

describe("canonical", () => {
  it("BASE_ATTRIBUTE_FIELDS includes the promoted base fields", () => {
    expect(BASE_ATTRIBUTE_FIELDS).toEqual(
      expect.arrayContaining(["title", "status", "langcode", "created", "changed", "path"])
    );
  });

  it("makeCanonicalEntity fills defaults and stamps backend", () => {
    const e = makeCanonicalEntity({ id: "u1", entityType: "node", bundle: "article", backend: "jsonapi" });
    expect(e).toMatchObject({
      id: "u1", entityType: "node", bundle: "article",
      title: null, status: null, langcode: null, created: null, changed: null, url: null,
      fields: {}, relationships: {}, _backend: "jsonapi",
    });
  });

  it("makeCanonicalEntity preserves provided values", () => {
    const e = makeCanonicalEntity({
      id: "u1", entityType: "node", bundle: "article",
      title: "Hi", status: true, url: "/hi", fields: { body: "x" },
      relationships: { author: { id: "a1", entityType: "user", bundle: "user" } },
      backend: "graphql",
    });
    expect(e.title).toBe("Hi");
    expect(e.status).toBe(true);
    expect(e.url).toBe("/hi");
    expect(e.fields).toEqual({ body: "x" });
    expect(e.relationships.author.id).toBe("a1");
    expect(e._backend).toBe("graphql");
  });

  it("normalizeRelationship splits JSON:API type into entityType/bundle", () => {
    expect(normalizeRelationship({ type: "node--article", id: "n1" }))
      .toEqual({ id: "n1", entityType: "node", bundle: "article" });
  });

  it("normalizeRelationship maps arrays", () => {
    const out = normalizeRelationship([
      { type: "taxonomy_term--tags", id: "t1" },
      { type: "taxonomy_term--tags", id: "t2" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: "t1", entityType: "taxonomy_term", bundle: "tags" });
  });

  it("normalizeRelationship returns null for empty input", () => {
    expect(normalizeRelationship(null)).toBeNull();
  });
});
