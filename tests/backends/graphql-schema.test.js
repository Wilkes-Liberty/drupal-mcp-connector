import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../../src/lib/drupal-fetch.js", () => ({ drupalGraphqlFetch: vi.fn(), drupalFetch: vi.fn(), drupalUploadFile: vi.fn() }));
import { drupalGraphqlFetch } from "../../src/lib/drupal-fetch.js";
import { loadSchemaMap, _clearSchemaCache } from "../../src/lib/backends/graphql-schema.js";

// Minimal introspection fixture: one node type + its connection + sort enum.
const INTROSPECTION = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      types: [
        {
          name: "Query", kind: "OBJECT",
          fields: [
            { name: "nodeArticle", args: [{ name: "id" }], type: { name: "NodeArticle", kind: "OBJECT", ofType: null } },
            { name: "nodeArticles", args: [{ name: "first" }], type: { name: "NodeArticleConnection", kind: "OBJECT", ofType: null } },
          ],
        },
        {
          name: "NodeArticle", kind: "OBJECT",
          fields: [
            { name: "id", type: { name: null, kind: "NON_NULL", ofType: { name: "ID", kind: "SCALAR" } } },
            { name: "title", type: { name: "String", kind: "SCALAR", ofType: null } },
            { name: "status", type: { name: null, kind: "NON_NULL", ofType: { name: "Boolean", kind: "SCALAR" } } },
            { name: "created", type: { name: null, kind: "NON_NULL", ofType: { name: "DateTime", kind: "OBJECT" } } },
            { name: "body", type: { name: "TextSummary", kind: "OBJECT", ofType: null } },
            { name: "tags", type: { name: null, kind: "LIST", ofType: { name: null, kind: "NON_NULL", ofType: { name: "TermUnion", kind: "UNION" } } } },
          ],
        },
        {
          name: "NodeArticleConnection", kind: "OBJECT",
          // Real graphql_compose shape: nodes is [NodeArticle!]! = NON_NULL(LIST(NON_NULL(NodeArticle))) — 4 wrapper levels.
          fields: [{ name: "nodes", type: { name: null, kind: "NON_NULL", ofType: { name: null, kind: "LIST", ofType: { name: null, kind: "NON_NULL", ofType: { name: "NodeArticle", kind: "OBJECT" } } } } }],
        },
        { name: "ConnectionSortKeys", kind: "ENUM", enumValues: [{ name: "CREATED_AT" }, { name: "TITLE" }] },
      ],
    },
  },
};

const site = { _name: "g", baseUrl: "https://x", graphqlEndpoint: "/graphql" };

beforeEach(() => {
  _clearSchemaCache();
  vi.mocked(drupalGraphqlFetch).mockReset();
  vi.mocked(drupalGraphqlFetch).mockResolvedValue(INTROSPECTION);
});

describe("loadSchemaMap", () => {
  it("introspects once and caches per site", async () => {
    await loadSchemaMap(site);
    await loadSchemaMap(site);
    expect(vi.mocked(drupalGraphqlFetch).mock.calls.length).toBe(1);
  });

  it("resolves single + collection field names for an entity bundle", async () => {
    const map = await loadSchemaMap(site);
    const e = map.forEntity("node", "article");
    expect(e.typeName).toBe("NodeArticle");
    expect(e.single).toBe("nodeArticle");
    expect(e.collection).toBe("nodeArticles");
  });

  it("captures field kinds (unwrapping NON_NULL/LIST)", async () => {
    const map = await loadSchemaMap(site);
    const e = map.forEntity("node", "article");
    expect(e.fields.get("status")).toMatchObject({ kind: "SCALAR", typeName: "Boolean" });
    expect(e.fields.get("created")).toMatchObject({ kind: "OBJECT", typeName: "DateTime" });
    expect(e.fields.get("tags")).toMatchObject({ kind: "LIST", ofTypeKind: "UNION", ofTypeName: "TermUnion" });
  });

  it("exposes sort keys and node bundles", async () => {
    const map = await loadSchemaMap(site);
    expect(map.sortKeys.has("CREATED_AT")).toBe(true);
    expect(map.nodeBundles()).toContain("article");
  });

  it("forEntity returns null for an unknown bundle", async () => {
    const map = await loadSchemaMap(site);
    expect(map.forEntity("node", "missing")).toBeNull();
  });

  it("entityForType maps a type name back to entityType/bundle", async () => {
    const map = await loadSchemaMap(site);
    expect(map.entityForType("NodeArticle")).toEqual({ entityType: "node", bundle: "article" });
    expect(map.entityForType("Unknown")).toBeNull();
  });
});
