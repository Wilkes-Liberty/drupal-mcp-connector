import { describe, it, expect } from "vitest";
import { pascalToSnake, snakeToPascal, graphqlTypeToEntity } from "../../src/lib/backends/graphql-names.js";

describe("graphql-names", () => {
  it("pascalToSnake", () => {
    expect(pascalToSnake("Article")).toBe("article");
    expect(pascalToSnake("CaseStudy")).toBe("case_study");
    expect(pascalToSnake("PHero")).toBe("p_hero");
  });

  it("snakeToPascal", () => {
    expect(snakeToPascal("article")).toBe("Article");
    expect(snakeToPascal("case_study")).toBe("CaseStudy");
  });

  it("graphqlTypeToEntity maps prefixed type names to entityType/bundle", () => {
    expect(graphqlTypeToEntity("NodeArticle")).toEqual({ entityType: "node", bundle: "article" });
    expect(graphqlTypeToEntity("NodeCaseStudy")).toEqual({ entityType: "node", bundle: "case_study" });
    expect(graphqlTypeToEntity("TermTags")).toEqual({ entityType: "taxonomy_term", bundle: "tags" });
    expect(graphqlTypeToEntity("MediaImage")).toEqual({ entityType: "media", bundle: "image" });
    expect(graphqlTypeToEntity("BlockContentBasic")).toEqual({ entityType: "block_content", bundle: "basic" });
  });

  it("graphqlTypeToEntity handles single-type entities (User)", () => {
    expect(graphqlTypeToEntity("User")).toEqual({ entityType: "user", bundle: "user" });
  });

  it("graphqlTypeToEntity returns null for unknown prefixes", () => {
    expect(graphqlTypeToEntity("WeirdThing")).toBeNull();
  });
});
