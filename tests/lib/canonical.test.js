import { describe, it, expect } from "vitest";
import {
  BASE_ATTRIBUTE_FIELDS,
  makeCanonicalEntity,
  normalizeRelationship,
  isRelationshipLinkage,
  splitReferenceFields,
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

describe("isRelationshipLinkage (#171)", () => {
  it("matches single refs, ref arrays, empty arrays, and null clears", () => {
    expect(isRelationshipLinkage({ data: { type: "media--image", id: "u1" } })).toBe(true);
    expect(isRelationshipLinkage({ data: [{ type: "media--image", id: "u1" }] })).toBe(true);
    expect(isRelationshipLinkage({ data: [] })).toBe(true);
    expect(isRelationshipLinkage({ data: null })).toBe(true);
  });

  it("rejects non-linkage values", () => {
    expect(isRelationshipLinkage({ value: "x", format: "basic_html" })).toBe(false);
    expect(isRelationshipLinkage("plain")).toBe(false);
    expect(isRelationshipLinkage(null)).toBe(false);
    expect(isRelationshipLinkage([{ type: "a--b", id: "u" }])).toBe(false);
    expect(isRelationshipLinkage({ data: { type: "media--image" } })).toBe(false);
    expect(isRelationshipLinkage({ data: [{ type: "media--image", id: "u1" }, "junk"] })).toBe(false);
  });
});

describe("splitReferenceFields (#171)", () => {
  it("routes linkage values to relationships and the rest to attributes", () => {
    const { attributes, relationships } = splitReferenceFields({
      field_poster: { data: { type: "media--image", id: "u1" } },
      field_caption: "Cap",
      field_body: { value: "x", format: "basic_html" },
    });
    expect(attributes).toEqual({ field_caption: "Cap", field_body: { value: "x", format: "basic_html" } });
    expect(relationships).toEqual({ field_poster: { data: { type: "media--image", id: "u1" } } });
  });

  it("returns null relationships when nothing is linkage-shaped", () => {
    const { attributes, relationships } = splitReferenceFields({ name: "N" });
    expect(attributes).toEqual({ name: "N" });
    expect(relationships).toBeNull();
  });
});
