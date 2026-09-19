import { describe, it, expect, vi, beforeEach } from "vitest";

const backend = {
  getEntitySchema: vi.fn(),
};
vi.mock("../../src/lib/backends/index.js", () => ({ resolveBackend: vi.fn(async () => backend) }));
vi.mock("../../src/lib/config.js", () => ({
  getSiteConfig: vi.fn((n) => ({ _name: n || "d", baseUrl: "https://x", security: {} })),
}));
vi.mock("../../src/lib/security.js", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    resolveSecurityConfig: vi.fn(() => ({
      globalRedactedFields: [],
      entityRules: {},
      allowedEntityTypes: null,
      deniedEntityTypes: [],
    })),
  };
});

import { handlers, definitions } from "../../src/tools/fields.js";

function sampledSchema(over = {}) {
  return {
    entityType: "node",
    bundle: "article",
    resourceType: "node--article",
    attributes: {
      title: "string",
      status: "boolean",
      created: "number",
      body: "text_with_summary",
      field_tags: "array<string>",
    },
    relationships: {
      uid: "relationship",
      field_image: "relationship",
    },
    ...over,
  };
}

beforeEach(() => Object.values(backend).forEach((f) => f.mockReset()));

describe("fields tools", () => {
  it("exposes drupal_describe_fields requiring site, accepting type or entityType, optional bundle", () => {
    const def = definitions.find((d) => d.name === "drupal_describe_fields");
    expect(def).toBeTruthy();
    expect(def.inputSchema.required).toEqual(["site"]);
    expect(def.inputSchema.properties).toHaveProperty("type");
    expect(def.inputSchema.properties).toHaveProperty("entityType");
    expect(def.inputSchema.properties).toHaveProperty("bundle");
  });

  it("accepts entityType as an alias for type (#116)", async () => {
    backend.getEntitySchema.mockResolvedValue(sampledSchema());
    const out = await handlers.drupal_describe_fields({ site: "d", entityType: "node", bundle: "article" });
    expect(backend.getEntitySchema).toHaveBeenCalledWith("node", "article");
    expect(out.entityType).toBe("node");
  });

  it("errors clearly when no entity type is given under either name (#116)", async () => {
    await expect(handlers.drupal_describe_fields({ site: "d", bundle: "article" }))
      .rejects.toThrow(/requires an entity type.*type.*entityType/is);
    expect(backend.getEntitySchema).not.toHaveBeenCalled();
  });

  it("describe_fields calls getEntitySchema with type+bundle and returns per-field descriptors", async () => {
    backend.getEntitySchema.mockResolvedValue(sampledSchema());
    const out = await handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "article" });

    expect(backend.getEntitySchema).toHaveBeenCalledWith("node", "article");
    expect(out.entityType).toBe("node");
    expect(out.bundle).toBe("article");

    expect(Array.isArray(out.fields)).toBe(true);
    const byName = Object.fromEntries(out.fields.map((f) => [f.name, f]));

    expect(byName.title).toMatchObject({ name: "title", type: "string", kind: "attribute" });
    expect(byName.body).toMatchObject({ name: "body", type: "text_with_summary", kind: "attribute" });
    // array<…> sampled type implies multi-valued cardinality hint
    expect(byName.field_tags).toMatchObject({ name: "field_tags", kind: "attribute" });
    expect(byName.field_tags.cardinality).toBe(-1);
    // relationships are flagged as such
    expect(byName.field_image).toMatchObject({ name: "field_image", type: "relationship", kind: "relationship" });
    expect(byName.uid).toMatchObject({ name: "uid", kind: "relationship" });
  });

  it("flags approximate:true and documents the Drush bridge as authoritative when sampling-only", async () => {
    backend.getEntitySchema.mockResolvedValue(sampledSchema());
    const out = await handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "article" });
    expect(out.approximate).toBe(true);
    expect(String(out.note || "")).toMatch(/drush/i);
    // per-field required/cardinality/allowedValues are flagged approximate too
    const title = out.fields.find((f) => f.name === "title");
    expect(title.approximate).toBe(true);
  });

  it("defaults bundle to entity type when bundle omitted", async () => {
    backend.getEntitySchema.mockResolvedValue(sampledSchema({ entityType: "user", bundle: "user", attributes: { name: "string" }, relationships: {} }));
    await handlers.drupal_describe_fields({ site: "d", type: "user" });
    expect(backend.getEntitySchema).toHaveBeenCalledWith("user", "user");
  });

  it("sets translatable from Field API when listFieldTranslatability is available", async () => {
    backend.getEntitySchema.mockResolvedValue(sampledSchema());
    backend.listFieldTranslatability = vi.fn(async () => ({ body: true, field_image: false }));
    const out = await handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "article" });
    const byName = Object.fromEntries(out.fields.map((f) => [f.name, f]));
    expect(byName.body.translatable).toBe(true);
    expect(byName.field_image.translatable).toBe(false);
    expect(byName.title.translatable).toBeUndefined();
    delete backend.listFieldTranslatability;
  });

  // #337: JSON:API omits a view-denied field from the resource, so sampling
  // cannot see it. Field API definitions the call already reads can.
  it("lists fields that Field API defines but the sampled entity does not carry as notVisible", async () => {
    backend.getEntitySchema.mockResolvedValue(sampledSchema());
    backend.listFieldTranslatability = vi.fn(async () => ({
      body: true, field_image: false, field_internal_notes: false, field_secret_ref: true,
    }));
    const out = await handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "article" });
    expect(out.fieldDefinitions).toBe("available");
    expect(out.notVisible).toEqual([
      { name: "field_internal_notes", translatable: false },
      { name: "field_secret_ref", translatable: true },
    ]);
    expect(out.notVisibleNote).toMatch(/denied to this account/);
    // They are listed apart: the sampled field list and its count are unchanged.
    expect(out.fields.map((f) => f.name)).not.toContain("field_internal_notes");
    expect(out.fieldCount).toBe(7);
    expect(backend.listFieldTranslatability).toHaveBeenCalledTimes(1);
    expect(backend.getEntitySchema).toHaveBeenCalledTimes(1);
    delete backend.listFieldTranslatability;
  });

  it("does not list a defined field whose key is present with an empty value", async () => {
    // The sampled type of a null attribute is still a key in the schema.
    backend.getEntitySchema.mockResolvedValue(sampledSchema({
      attributes: { title: "string", field_subtitle: "null" },
      relationships: { field_image: "relationship" },
    }));
    backend.listFieldTranslatability = vi.fn(async () => ({ field_subtitle: true, field_image: false }));
    const out = await handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "article" });
    expect(out.notVisible).toEqual([]);
    expect(out).not.toHaveProperty("notVisibleNote");
    delete backend.listFieldTranslatability;
  });

  it("says so when field definitions are unavailable, and claims nothing", async () => {
    backend.getEntitySchema.mockResolvedValue(sampledSchema());
    const bare = await handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "article" });
    expect(bare.fieldDefinitions).toBe("unavailable");
    expect(bare).not.toHaveProperty("notVisible");
    expect(bare.note).toMatch(/not visible|denied/i);

    backend.listFieldTranslatability = vi.fn(async () => ({}));
    const empty = await handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "article" });
    expect(empty.fieldDefinitions).toBe("unavailable");
    expect(empty).not.toHaveProperty("notVisible");

    backend.listFieldTranslatability = vi.fn(async () => { throw new Error("Drupal 403"); });
    const denied = await handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "article" });
    expect(denied.fieldDefinitions).toBe("unavailable");
    expect(denied).not.toHaveProperty("notVisible");
    delete backend.listFieldTranslatability;
  });

  it("claims nothing about visibility when no entity was sampled", async () => {
    backend.getEntitySchema.mockResolvedValue({ entityType: "node", bundle: "page", attributes: {}, relationships: {} });
    backend.listFieldTranslatability = vi.fn(async () => ({ body: true }));
    const out = await handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "page" });
    expect(out).not.toHaveProperty("notVisible");
    delete backend.listFieldTranslatability;
  });

  it("handles an empty schema (no entities sampled) gracefully", async () => {
    backend.getEntitySchema.mockResolvedValue({
      entityType: "node",
      bundle: "page",
      note: "No entities exist yet — schema unavailable.",
      attributes: {},
      relationships: {},
    });
    const out = await handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "page" });
    expect(out.fields).toEqual([]);
    expect(out.approximate).toBe(true);
    expect(out.fieldCount).toBe(0);
  });

  it("propagates a SecurityError and never queries the backend when read is blocked", async () => {
    const { resolveSecurityConfig } = await import("../../src/lib/security.js");
    resolveSecurityConfig.mockReturnValueOnce({
      globalRedactedFields: [],
      entityRules: {},
      allowedEntityTypes: null,
      deniedEntityTypes: ["node"],
    });
    backend.getEntitySchema.mockResolvedValue(sampledSchema());
    await expect(
      handlers.drupal_describe_fields({ site: "d", type: "node", bundle: "article" })
    ).rejects.toThrow();
    expect(backend.getEntitySchema).not.toHaveBeenCalled();
  });
});
