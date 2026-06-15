import { vi, beforeEach } from "vitest";
vi.mock("../../src/lib/drupal-fetch.js", () => ({
  drupalFetch: vi.fn(),
  drupalUploadFile: vi.fn(),
}));
import { drupalFetch, drupalUploadFile } from "../../src/lib/drupal-fetch.js";
import { describe, it, expect } from "vitest";
import { JsonApiBackend, isModeratedStatusError } from "../../src/lib/backends/jsonapi.js";

function paramsOf(descriptor) {
  const b = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  return b.compileQuery(descriptor);
}

describe("JsonApiBackend.compileQuery", () => {
  it("compiles pagination and sort", () => {
    const p = paramsOf({ entityType: "node", bundle: "article", sort: [{ field: "changed", dir: "desc" }], page: { limit: 10, offset: 20 } });
    expect(p.get("sort")).toBe("-changed");
    expect(p.get("page[limit]")).toBe("10");
    expect(p.get("page[offset]")).toBe("20");
  });

  it("compiles sparse fields and includes", () => {
    const p = paramsOf({ entityType: "node", bundle: "article", fields: ["title", "body"], include: ["uid"] });
    expect(p.get("fields[node--article]")).toBe("title,body");
    expect(p.get("include")).toBe("uid");
  });

  it("compiles an eq filter with the shorthand", () => {
    const p = paramsOf({ entityType: "node", bundle: "article", filters: [{ field: "status", op: "eq", value: "1" }] });
    expect(p.get("filter[status]")).toBe("1");
  });

  it("compiles an operator filter with the verbose condition form", () => {
    const p = paramsOf({ entityType: "node", bundle: "article", filters: [{ field: "changed", op: "lt", value: "2025-01-01" }] });
    expect(p.get("filter[c_changed][condition][path]")).toBe("changed");
    expect(p.get("filter[c_changed][condition][operator]")).toBe("<");
    expect(p.get("filter[c_changed][condition][value]")).toBe("2025-01-01");
  });

  it("compiles an 'in' filter with an indexed value array", () => {
    const p = paramsOf({ entityType: "node", bundle: "article", filters: [{ field: "nid", op: "in", value: ["1", "2", "3"] }] });
    expect(p.get("filter[c_nid][condition][operator]")).toBe("IN");
    expect(p.get("filter[c_nid][condition][value][0]")).toBe("1");
    expect(p.get("filter[c_nid][condition][value][2]")).toBe("3");
  });

  it("compiles an 'isNull' filter with no value key", () => {
    const p = paramsOf({ entityType: "node", bundle: "article", filters: [{ field: "field_image", op: "isNull", value: null }] });
    expect(p.get("filter[c_field_image][condition][operator]")).toBe("IS NULL");
    expect(p.get("filter[c_field_image][condition][value]")).toBeNull();
  });

  it("capabilities are all-capable for JSON:API", () => {
    const caps = new JsonApiBackend({ _name: "t", baseUrl: "https://x" }).capabilities();
    expect(caps).toMatchObject({ read: true, write: true, delete: true, count: true, filter: true, sort: "full", revisions: true });
  });
});

describe("JsonApiBackend.toCanonical", () => {
  const backend = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  const resource = {
    type: "node--article",
    id: "uuid-1",
    attributes: {
      drupal_internal__nid: 42,
      title: "Hello",
      status: true,
      langcode: "en",
      created: "2025-01-01T00:00:00+00:00",
      changed: "2025-02-01T00:00:00+00:00",
      path: { alias: "/hello" },
      body: { value: "<p>hi</p>", summary: "hi" },
      field_meta_description: "desc",
    },
    relationships: {
      uid: { data: { type: "user--user", id: "user-1" } },
      field_tags: { data: [{ type: "taxonomy_term--tags", id: "term-1" }] },
    },
  };

  it("promotes base fields and url", () => {
    const c = backend.toCanonical(resource);
    expect(c.id).toBe("uuid-1");
    expect(c.entityType).toBe("node");
    expect(c.bundle).toBe("article");
    expect(c.title).toBe("Hello");
    expect(c.status).toBe(true);
    expect(c.url).toBe("/hello");
    expect(c._backend).toBe("jsonapi");
  });

  it("puts non-base, non-internal attributes in fields", () => {
    const c = backend.toCanonical(resource);
    expect(c.fields.body).toEqual({ value: "<p>hi</p>", summary: "hi" });
    expect(c.fields.field_meta_description).toBe("desc");
    expect(c.fields).not.toHaveProperty("title");
    expect(c.fields).not.toHaveProperty("drupal_internal__nid");
    expect(c.fields).not.toHaveProperty("path");
  });

  it("normalizes relationships", () => {
    const c = backend.toCanonical(resource);
    expect(c.relationships.uid).toEqual({ id: "user-1", entityType: "user", bundle: "user" });
    expect(c.relationships.field_tags).toEqual([{ id: "term-1", entityType: "taxonomy_term", bundle: "tags" }]);
  });
});

describe("JsonApiBackend fetch methods", () => {
  const backend = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  beforeEach(() => vi.mocked(drupalFetch).mockReset());

  it("listEntities returns canonical entities and total", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({
      data: [{ type: "node--article", id: "u1", attributes: { title: "A", status: true } }],
      meta: { count: 7 },
      links: { next: { href: "x" } },
    });
    const res = await backend.listEntities({ entityType: "node", bundle: "article", page: { limit: 1 } });
    expect(res.entities).toHaveLength(1);
    expect(res.entities[0].title).toBe("A");
    expect(res.page.total).toBe(7);
    expect(res.page.hasNext).toBe(true);
    expect(res.approximate).toBe(false);
    // path includes the resource and the page limit
    expect(vi.mocked(drupalFetch).mock.calls[0][1]).toContain("/jsonapi/node/article?");
    expect(vi.mocked(drupalFetch).mock.calls[0][1]).toContain("page%5Blimit%5D=1");
  });

  it("getEntity returns a canonical entity or null", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ data: { type: "node--article", id: "u1", attributes: { title: "A" } } });
    const c = await backend.getEntity({ entityType: "node", bundle: "article", id: "u1" });
    expect(c.id).toBe("u1");
    vi.mocked(drupalFetch).mockResolvedValue(null);
    const none = await backend.getEntity({ entityType: "node", bundle: "article", id: "u2" });
    expect(none).toBeNull();
  });

  it("createEntity POSTs a JSON:API payload", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ data: { type: "node--article", id: "new", attributes: { title: "N" } } });
    const c = await backend.createEntity({ entityType: "node", bundle: "article", attributes: { title: "N", status: false } });
    expect(c.id).toBe("new");
    const [, path, opts] = vi.mocked(drupalFetch).mock.calls[0];
    expect(path).toBe("/jsonapi/node/article");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ data: { type: "node--article", attributes: { title: "N", status: false } } });
  });

  it("updateEntity PATCHes a JSON:API payload with id in the body", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ data: { type: "node--article", id: "u1", attributes: { title: "Updated" } } });
    const c = await backend.updateEntity({ entityType: "node", bundle: "article", id: "u1", attributes: { title: "Updated" } });
    expect(c.id).toBe("u1");
    const [, path, opts] = vi.mocked(drupalFetch).mock.calls[0];
    expect(path).toBe("/jsonapi/node/article/u1");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ data: { type: "node--article", id: "u1", attributes: { title: "Updated" } } });
  });

  it("deleteEntity issues a DELETE and resolves void", async () => {
    vi.mocked(drupalFetch).mockResolvedValue(null);
    await expect(backend.deleteEntity({ entityType: "node", bundle: "article", id: "u1" })).resolves.toBeUndefined();
    const [, path, opts] = vi.mocked(drupalFetch).mock.calls[0];
    expect(path).toBe("/jsonapi/node/article/u1");
    expect(opts.method).toBe("DELETE");
  });

  it("listContentTypes maps node_type resources", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({
      data: [{ attributes: { drupal_internal__type: "article", name: "Article", description: "Articles" } }],
    });
    const types = await backend.listContentTypes();
    expect(types).toEqual([{ id: "article", label: "Article", description: "Articles" }]);
  });

  it("introspect returns resourceTypes from /jsonapi links", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ links: { self: { href: "s" }, "node--article": { href: "a" } } });
    const info = await backend.introspect();
    expect(info.resourceTypes).toEqual(["node--article"]);
  });
});

describe("JsonApiBackend content_moderation fallback", () => {
  const backend = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  beforeEach(() => vi.mocked(drupalFetch).mockReset());

  const moderatedErr = () => new Error(
    "Drupal 403 on POST /jsonapi/node/article: The current user is not allowed to POST the selected field (status). Cannot edit the published field of moderated entities."
  );

  it("createEntity retries without status when a moderated bundle rejects the published field", async () => {
    vi.mocked(drupalFetch)
      .mockRejectedValueOnce(moderatedErr())
      .mockResolvedValueOnce({ data: { type: "node--article", id: "new", attributes: { title: "N" } } });
    const c = await backend.createEntity({ entityType: "node", bundle: "article", attributes: { title: "N", status: false } });
    expect(c.id).toBe("new");
    expect(vi.mocked(drupalFetch)).toHaveBeenCalledTimes(2);
    // first attempt carried status; retry stripped only status, kept other attrs
    expect(JSON.parse(vi.mocked(drupalFetch).mock.calls[0][2].body).data.attributes).toHaveProperty("status");
    const retry = JSON.parse(vi.mocked(drupalFetch).mock.calls[1][2].body).data.attributes;
    expect(retry).not.toHaveProperty("status");
    expect(retry.title).toBe("N");
  });

  it("updateEntity retries without status when a moderated bundle rejects the published field", async () => {
    vi.mocked(drupalFetch)
      .mockRejectedValueOnce(moderatedErr())
      .mockResolvedValueOnce({ data: { type: "node--article", id: "u1", attributes: { title: "U" } } });
    const c = await backend.updateEntity({ entityType: "node", bundle: "article", id: "u1", attributes: { title: "U", status: true } });
    expect(c.id).toBe("u1");
    expect(vi.mocked(drupalFetch)).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(vi.mocked(drupalFetch).mock.calls[1][2].body).data.attributes;
    expect(retry).not.toHaveProperty("status");
    expect(retry.title).toBe("U");
  });

  it("does NOT retry on a non-moderated bundle — the first write succeeds, status is preserved", async () => {
    // Plain Drupal (no content_moderation): POST with status succeeds, so the
    // moderation fallback never engages and status passes through unchanged.
    vi.mocked(drupalFetch).mockResolvedValueOnce({ data: { type: "node--page", id: "new", attributes: { title: "P", status: false } } });
    const c = await backend.createEntity({ entityType: "node", bundle: "page", attributes: { title: "P", status: false } });
    expect(c.id).toBe("new");
    expect(vi.mocked(drupalFetch)).toHaveBeenCalledTimes(1); // no fallback request
    expect(JSON.parse(vi.mocked(drupalFetch).mock.calls[0][2].body).data.attributes.status).toBe(false);
  });
});

describe("isModeratedStatusError (retry guard)", () => {
  it("matches the moderated published-field 403", () => {
    expect(isModeratedStatusError(new Error("Drupal 403 on POST /jsonapi/node/article: Cannot edit the published field of moderated entities."))).toBe(true);
  });
  it("matches the 'field (status)' permission phrasing", () => {
    expect(isModeratedStatusError(new Error("The current user is not allowed to POST the selected field (status)."))).toBe(true);
  });
  it("does not match unrelated errors", () => {
    expect(isModeratedStatusError(new Error("Drupal 422 on POST /jsonapi/node/article: title is required"))).toBe(false);
    expect(isModeratedStatusError(new Error("Drupal 403: access denied"))).toBe(false);
    expect(isModeratedStatusError(undefined)).toBe(false);
  });
});

describe("JsonApiBackend.rawQuery", () => {
  const backend = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  beforeEach(() => vi.mocked(drupalFetch).mockReset());

  it("performs a raw JSON:API GET at the given path and returns the body", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ data: [{ type: "node--article", id: "u1" }] });
    const out = await backend.rawQuery({ path: "/jsonapi/node/article?page[limit]=1" });
    expect(out).toEqual({ data: [{ type: "node--article", id: "u1" }] });
    expect(vi.mocked(drupalFetch).mock.calls[0][1]).toBe("/jsonapi/node/article?page[limit]=1");
  });
});

describe("JsonApiBackend.listBundles", () => {
  const backend = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  beforeEach(() => vi.mocked(drupalFetch).mockReset());

  it("lists node bundles from node_type", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({
      data: [{ attributes: { drupal_internal__type: "article", name: "Article", description: "Arts" } }],
    });
    const out = await backend.listBundles("node");
    expect(out).toEqual([{ id: "article", label: "Article", description: "Arts" }]);
    expect(vi.mocked(drupalFetch).mock.calls[0][1]).toContain("/jsonapi/node_type/node_type");
  });

  it("lists taxonomy vocabularies", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({
      data: [{ attributes: { drupal_internal__vid: "tags", name: "Tags", description: null } }],
    });
    const out = await backend.listBundles("taxonomy_term");
    expect(out).toEqual([{ id: "tags", label: "Tags", description: null }]);
    expect(vi.mocked(drupalFetch).mock.calls[0][1]).toContain("/jsonapi/taxonomy_vocabulary/taxonomy_vocabulary");
  });

  it("throws for an entity type with no known bundle endpoint", async () => {
    await expect(backend.listBundles("widget")).rejects.toThrow(/no bundle/i);
  });
});

describe("JsonApiBackend.listResourceTypes", () => {
  const backend = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  beforeEach(() => vi.mocked(drupalFetch).mockReset());

  it("parses /jsonapi link keys into entityType/bundle", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({
      links: { self: { href: "s" }, "node--article": { href: "a" }, "taxonomy_term--tags": { href: "t" } },
    });
    const out = await backend.listResourceTypes();
    expect(out).toEqual([
      { resourceType: "node--article", entityType: "node", bundle: "article" },
      { resourceType: "taxonomy_term--tags", entityType: "taxonomy_term", bundle: "tags" },
    ]);
  });
});

describe("JsonApiBackend.listRoles", () => {
  const backend = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  beforeEach(() => vi.mocked(drupalFetch).mockReset());

  it("lists user roles from user_role", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({
      data: [{ id: "r1", attributes: { drupal_internal__id: "editor", label: "Editor", weight: 1 } }],
    });
    const out = await backend.listRoles();
    expect(out).toEqual([{ id: "r1", machineName: "editor", label: "Editor", weight: 1 }]);
    expect(vi.mocked(drupalFetch).mock.calls[0][1]).toContain("/jsonapi/user_role/user_role");
  });
});

describe("JsonApiBackend.getEntitySchema", () => {
  const backend = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  beforeEach(() => vi.mocked(drupalFetch).mockReset());

  it("infers attributes + relationships from a sampled entity", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({
      data: [{ type: "node--article", id: "n1",
        attributes: { title: "T", body: { value: "x", format: "f", processed: "p", summary: "s" }, promote: true },
        relationships: { uid: { data: { type: "user--user", id: "u1" } } } }],
    });
    const out = await backend.getEntitySchema("node", "article");
    expect(out.entityType).toBe("node");
    expect(out.attributes.title).toBe("string");
    expect(out.attributes.body).toBe("text_with_summary");
    expect(out.attributes.promote).toBe("boolean");
    expect(out.relationships.uid).toBe("relationship");
  });

  it("returns empty schema when no entities exist", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ data: [] });
    const out = await backend.getEntitySchema("node", "article");
    expect(out.attributes).toEqual({});
    expect(out.note).toMatch(/no entities/i);
  });
});

describe("JsonApiBackend.uploadFile", () => {
  const backend = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  beforeEach(() => vi.mocked(drupalUploadFile).mockReset());

  it("wraps drupalUploadFile and shapes the file descriptor", async () => {
    vi.mocked(drupalUploadFile).mockResolvedValue({
      data: { id: "f1", attributes: {
        drupal_internal__fid: 9, filename: "x.jpg",
        uri: { value: "public://x.jpg", url: "/files/x.jpg" }, filesize: 123, filemime: "image/jpeg",
      } },
    });
    const out = await backend.uploadFile({ entityType: "media", bundle: "image", fieldName: "field_media_image", filePath: "/tmp/x.jpg" });
    expect(out).toEqual({ id: "f1", drupalId: 9, filename: "x.jpg", uri: "public://x.jpg", url: "/files/x.jpg", size: 123, mimeType: "image/jpeg" });
    expect(vi.mocked(drupalUploadFile)).toHaveBeenCalledWith(backend.site, "media", "image", "field_media_image", "/tmp/x.jpg");
  });
});

describe("JsonApiBackend.countEntities", () => {
  const backend = new JsonApiBackend({ _name: "t", baseUrl: "https://x" });
  beforeEach(() => vi.mocked(drupalFetch).mockReset());
  it("returns the exact meta.count with approximate:false", async () => {
    vi.mocked(drupalFetch).mockResolvedValue({ data: [{ type: "node--article", id: "n1" }], meta: { count: 42 } });
    const r = await backend.countEntities({ entityType: "node", bundle: "article", filters: [{ field: "status", op: "eq", value: "1" }] });
    expect(r).toEqual({ count: 42, approximate: false });
    expect(vi.mocked(drupalFetch).mock.calls[0][1]).toContain("page%5Blimit%5D=1");
  });
});
