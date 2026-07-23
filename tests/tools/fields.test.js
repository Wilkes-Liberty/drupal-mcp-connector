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
