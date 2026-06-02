import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../../src/lib/drupal-fetch.js", () => ({ drupalGraphqlFetch: vi.fn(), drupalFetch: vi.fn(), drupalUploadFile: vi.fn() }));
import { drupalGraphqlFetch } from "../../src/lib/drupal-fetch.js";
import { GraphqlBackend } from "../../src/lib/backends/graphql.js";
import { _clearSchemaCache } from "../../src/lib/backends/graphql-schema.js";
import { BackendCapabilityError } from "../../src/lib/backends/errors.js";

const INTROSPECTION = {
  data: { __schema: {
    queryType: { name: "Query" },
    types: [
      { name: "Query", kind: "OBJECT", fields: [
        { name: "nodeArticle", args: [{ name: "id" }], type: { name: "NodeArticle", kind: "OBJECT", ofType: null } },
        { name: "nodeArticles", args: [{ name: "first" }], type: { name: "NodeArticleConnection", kind: "OBJECT", ofType: null } },
      ] },
      { name: "NodeArticle", kind: "OBJECT", fields: [
        { name: "id", type: { name: "ID", kind: "SCALAR", ofType: null } },
        { name: "title", type: { name: "String", kind: "SCALAR", ofType: null } },
        { name: "status", type: { name: null, kind: "NON_NULL", ofType: { name: "Boolean", kind: "SCALAR" } } },
        { name: "created", type: { name: "DateTime", kind: "OBJECT", ofType: null } },
        { name: "tags", type: { name: null, kind: "LIST", ofType: { name: null, kind: "NON_NULL", ofType: { name: "TermInterface", kind: "UNION" } } } },
      ] },
      { name: "NodeArticleConnection", kind: "OBJECT", fields: [
        { name: "nodes", type: { name: null, kind: "LIST", ofType: { name: "NodeArticle", kind: "OBJECT" } } },
      ] },
      { name: "ConnectionSortKeys", kind: "ENUM", enumValues: [{ name: "CREATED_AT" }, { name: "TITLE" }] },
    ],
  } },
};

const site = { _name: "g", baseUrl: "https://x", graphqlEndpoint: "/graphql" };

function mockArticles(nodes, hasNextPage = false, endCursor = null) {
  return { data: { nodeArticles: { pageInfo: { hasNextPage, endCursor }, nodes } } };
}

beforeEach(() => {
  _clearSchemaCache();
  vi.mocked(drupalGraphqlFetch).mockReset();
});

describe("GraphqlBackend", () => {
  it("capabilities reflect a read-only GraphQL backend", () => {
    const b = new GraphqlBackend(site);
    expect(b.capabilities()).toMatchObject({ read: true, write: false, delete: false, count: false, filter: false, sort: "enum", revisions: false });
    expect(typeof b.capabilities().fieldAvailability).toBe("function");
  });

  it("writes throw BackendCapabilityError", async () => {
    const b = new GraphqlBackend(site);
    await expect(b.createEntity({ entityType: "node", bundle: "article", attributes: {} })).rejects.toBeInstanceOf(BackendCapabilityError);
    await expect(b.updateEntity({ entityType: "node", bundle: "article", id: "x", attributes: {} })).rejects.toBeInstanceOf(BackendCapabilityError);
    await expect(b.deleteEntity({ entityType: "node", bundle: "article", id: "x" })).rejects.toBeInstanceOf(BackendCapabilityError);
  });

  it("listEntities does a native page when no filters and sort maps to a sortKey", async () => {
    vi.mocked(drupalGraphqlFetch)
      .mockResolvedValueOnce(INTROSPECTION) // schema load
      .mockResolvedValueOnce(mockArticles([
        { __typename: "NodeArticle", id: "n1", title: "A", status: true, created: { time: "2025-01-01T00:00:00+00:00" } },
      ], true, "CUR1"));
    const b = new GraphqlBackend(site);
    const res = await b.listEntities({ entityType: "node", bundle: "article", sort: [{ field: "created", dir: "desc" }], page: { limit: 1 } });
    expect(res.entities).toHaveLength(1);
    expect(res.entities[0].title).toBe("A");
    expect(res.entities[0]._backend).toBe("graphql");
    expect(res.page.hasNext).toBe(true);
    expect(res.page.cursor).toBe("CUR1");
    expect(res.approximate).toBe(false);
    // The 2nd call is the data query; assert it used sortKey CREATED_AT + reverse.
    const dataQuery = vi.mocked(drupalGraphqlFetch).mock.calls[1][1].query;
    expect(dataQuery).toContain("sortKey: CREATED_AT");
    expect(dataQuery).toContain("reverse: true");
  });

  it("listEntities filters client-side and flags approximate when capped", async () => {
    // Two pages of data, then filter status=false client-side.
    vi.mocked(drupalGraphqlFetch)
      .mockResolvedValueOnce(INTROSPECTION)
      .mockResolvedValueOnce(mockArticles([
        { __typename: "NodeArticle", id: "n1", title: "A", status: true, created: { time: "2025-01-01T00:00:00+00:00" } },
        { __typename: "NodeArticle", id: "n2", title: "B", status: false, created: { time: "2025-02-01T00:00:00+00:00" } },
      ], false, null));
    const b = new GraphqlBackend(site);
    const res = await b.listEntities({ entityType: "node", bundle: "article", filters: [{ field: "status", op: "eq", value: false }], page: { limit: 50 } });
    expect(res.entities.map((e) => e.id)).toEqual(["n2"]);
    expect(res.approximate).toBe(true); // count is derived client-side
  });

  it("listEntities sets truncated:true when the client-side cap is hit", async () => {
    const page100 = Array.from({ length: 100 }, (_, i) => ({
      __typename: "NodeArticle", id: `n${i}`, title: `T${i}`, status: true,
    }));
    // Default: every data page is full with a next cursor; first call is the schema.
    vi.mocked(drupalGraphqlFetch).mockResolvedValue(mockArticles(page100, true, "CUR"));
    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce(INTROSPECTION);
    const b = new GraphqlBackend(site);
    const res = await b.listEntities({
      entityType: "node", bundle: "article",
      filters: [{ field: "status", op: "eq", value: true }],
      page: { limit: 50 },
    });
    expect(res.truncated).toBe(true);
    expect(res.approximate).toBe(true);
    expect(res.entities).toHaveLength(50); // sliced to limit
  });

  it("listEntities throws when the GraphQL response carries errors (not silently empty)", async () => {
    vi.mocked(drupalGraphqlFetch)
      .mockResolvedValueOnce(INTROSPECTION)
      .mockResolvedValueOnce({ data: null, errors: [{ message: "Field broke" }] });
    const b = new GraphqlBackend(site);
    await expect(
      b.listEntities({ entityType: "node", bundle: "article", sort: [{ field: "created", dir: "desc" }], page: { limit: 1 } })
    ).rejects.toThrow(/Field broke/);
  });

  it("getEntity returns canonical or null", async () => {
    vi.mocked(drupalGraphqlFetch)
      .mockResolvedValueOnce(INTROSPECTION)
      .mockResolvedValueOnce({ data: { nodeArticle: { __typename: "NodeArticle", id: "n1", title: "A", status: true } } });
    const b = new GraphqlBackend(site);
    const c = await b.getEntity({ entityType: "node", bundle: "article", id: "n1" });
    expect(c.id).toBe("n1");

    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce({ data: { nodeArticle: null } });
    const none = await b.getEntity({ entityType: "node", bundle: "article", id: "missing" });
    expect(none).toBeNull();
  });

  it("listEntities throws BackendCapabilityError for an unknown bundle", async () => {
    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce(INTROSPECTION);
    const b = new GraphqlBackend(site);
    await expect(b.listEntities({ entityType: "node", bundle: "missing" })).rejects.toBeInstanceOf(BackendCapabilityError);
  });

  it("listContentTypes returns node bundles", async () => {
    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce(INTROSPECTION);
    const b = new GraphqlBackend(site);
    const types = await b.listContentTypes();
    expect(types).toEqual([{ id: "article", label: "article", description: null }]);
  });
});

describe("GraphqlBackend.listBundles", () => {
  beforeEach(() => { _clearSchemaCache(); vi.mocked(drupalGraphqlFetch).mockReset(); });

  it("derives node bundles from the schema map", async () => {
    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce(INTROSPECTION);
    const b = new GraphqlBackend(site);
    const out = await b.listBundles("node");
    expect(out).toEqual([{ id: "article", label: "article", description: null }]);
  });

  it("returns [] for an entity type the schema does not expose", async () => {
    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce(INTROSPECTION);
    const b = new GraphqlBackend(site);
    expect(await b.listBundles("commerce_product")).toEqual([]);
  });
});

describe("GraphqlBackend.listResourceTypes", () => {
  beforeEach(() => { _clearSchemaCache(); vi.mocked(drupalGraphqlFetch).mockReset(); });

  it("derives resource types from the schema map", async () => {
    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce(INTROSPECTION);
    const b = new GraphqlBackend(site);
    const out = await b.listResourceTypes();
    expect(out).toContainEqual({ resourceType: "node--article", entityType: "node", bundle: "article" });
  });
});

describe("GraphqlBackend.listRoles", () => {
  it("throws BackendCapabilityError (roles not in the GraphQL schema)", async () => {
    const b = new GraphqlBackend(site);
    await expect(b.listRoles()).rejects.toBeInstanceOf(BackendCapabilityError);
  });
});

describe("GraphqlBackend.getEntitySchema", () => {
  beforeEach(() => { _clearSchemaCache(); vi.mocked(drupalGraphqlFetch).mockReset(); });

  it("derives attributes + relationships from the schema map fields", async () => {
    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce(INTROSPECTION);
    const b = new GraphqlBackend(site);
    const out = await b.getEntitySchema("node", "article");
    expect(out.entityType).toBe("node");
    expect(out.attributes.title).toBe("String");
    expect(out.attributes.status).toBe("Boolean");
    expect(out.attributes.created).toBe("DateTime");
    // tags is a union list -> relationship
    expect(out.relationships.tags).toBe("relationship");
  });

  it("throws BackendCapabilityError for an unknown bundle", async () => {
    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce(INTROSPECTION);
    const b = new GraphqlBackend(site);
    await expect(b.getEntitySchema("node", "missing")).rejects.toBeInstanceOf(BackendCapabilityError);
  });
});

describe("GraphqlBackend.uploadFile", () => {
  it("throws BackendCapabilityError (no GraphQL upload)", async () => {
    const b = new GraphqlBackend(site);
    await expect(b.uploadFile({ entityType: "media", bundle: "image", fieldName: "f", filePath: "/tmp/x" }))
      .rejects.toBeInstanceOf(BackendCapabilityError);
  });
});

describe("GraphqlBackend.countEntities", () => {
  beforeEach(() => { _clearSchemaCache(); vi.mocked(drupalGraphqlFetch).mockReset(); });
  it("counts via bounded pagination and flags approximate", async () => {
    const page = Array.from({ length: 3 }, (_, i) => ({ __typename: "NodeArticle", id: `n${i}`, status: true }));
    vi.mocked(drupalGraphqlFetch).mockResolvedValue(mockArticles(page, false, null));
    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce(INTROSPECTION);
    const b = new GraphqlBackend(site);
    const r = await b.countEntities({ entityType: "node", bundle: "article" });
    expect(r.count).toBe(3);
    expect(r.approximate).toBe(true); // GraphQL has no exact server-side count
  });
});

describe("GraphqlBackend.listEntities offset", () => {
  beforeEach(() => { _clearSchemaCache(); vi.mocked(drupalGraphqlFetch).mockReset(); });
  it("applies page.offset to the native result window", async () => {
    const nodes = Array.from({ length: 5 }, (_, i) => ({ __typename: "NodeArticle", id: `n${i}`, title: `T${i}`, status: true }));
    vi.mocked(drupalGraphqlFetch).mockResolvedValueOnce(INTROSPECTION).mockResolvedValueOnce(mockArticles(nodes, true, "C"));
    const b = new GraphqlBackend(site);
    const res = await b.listEntities({ entityType: "node", bundle: "article", page: { limit: 2, offset: 2 } });
    expect(res.entities.map((e) => e.id)).toEqual(["n2", "n3"]);
  });
});
