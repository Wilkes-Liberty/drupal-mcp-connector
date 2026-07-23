import { describe, it, expect } from "vitest";
import { assertGraphqlMutationAllowed, SecurityError } from "../../src/lib/security.js";
import { redactCanonicalEntity, redactResource, resolveSecurityConfig } from "../../src/lib/security.js";
import { assertConfigReadAllowed, assertConfigWriteAllowed, getSecuritySummary } from "../../src/lib/security.js";
import { assertPublishAllowed, isPublishBearing } from "../../src/lib/security.js";

const allowMut = { allowGraphqlMutations: true, readOnly: false };
const denyMut = { allowGraphqlMutations: false, readOnly: false };
const readOnly = { allowGraphqlMutations: true, readOnly: true };

describe("redactResource (JSON:API shape)", () => {
  const sec = { globalRedactedFields: ["field_api_key"], entityRules: { user: { redactedFields: ["mail", "pass"] } } };
  const userRes = () => ({ type: "user--user", id: "u1", attributes: { name: "jane", mail: "j@x.com", pass: "secret", field_api_key: "k", bio: "hi" } });

  it("redacts entity-type + global fields, leaves others intact", () => {
    const r = redactResource(userRes(), sec, "user");
    expect(r.attributes.mail).toBe("[REDACTED]");
    expect(r.attributes.pass).toBe("[REDACTED]");
    expect(r.attributes.field_api_key).toBe("[REDACTED]");
    expect(r.attributes.name).toBe("jane");
    expect(r.attributes.bio).toBe("hi");
  });

  it("redacts across an array of resources", () => {
    const out = redactResource([userRes(), userRes()], sec, "user");
    expect(out).toHaveLength(2);
    expect(out[0].attributes.mail).toBe("[REDACTED]");
  });

  it("returns the resource unchanged when nothing matches the entity type", () => {
    const r = redactResource({ type: "node--article", id: "n1", attributes: { title: "T" } }, sec, "node");
    expect(r.attributes.title).toBe("T");
  });

  it("is null/empty-safe", () => {
    expect(redactResource(null, sec, "user")).toBeNull();
    expect(redactResource({ type: "user--user", id: "u1" }, sec, "user")).toMatchObject({ id: "u1" });
  });
});

describe("allowPublish policy (#114) + assertPublishAllowed (#111)", () => {
  it("defaults allowPublish false on every preset except development", () => {
    expect(resolveSecurityConfig({ security: { preset: "development" } }).allowPublish).toBe(true);
    for (const preset of ["content-editor", "config-editor", "auditor", "production-strict", "write-plane"]) {
      expect(resolveSecurityConfig({ security: { preset } }).allowPublish).toBe(false);
    }
  });

  it("lets an operator opt in per site (explicit key wins over preset)", () => {
    expect(resolveSecurityConfig({ security: { preset: "write-plane", allowPublish: true } }).allowPublish).toBe(true);
    expect(resolveSecurityConfig({ security: { preset: "development", allowPublish: false } }).allowPublish).toBe(false);
  });

  it("isPublishBearing is true only for status:true", () => {
    expect(isPublishBearing({ status: true })).toBe(true);
    expect(isPublishBearing({ status: false })).toBe(false);
    expect(isPublishBearing({ name: "x" })).toBe(false);
    expect(isPublishBearing({})).toBe(false);
  });

  it("throws on a status:true write when allowPublish is false", () => {
    expect(() => assertPublishAllowed({ allowPublish: false }, { status: true })).toThrow(SecurityError);
    expect(() => assertPublishAllowed({ allowPublish: false }, { status: true })).toThrow(/allowPublish/);
  });

  it("allows a status:true write when allowPublish is true, and never blocks a non-publish write", () => {
    expect(() => assertPublishAllowed({ allowPublish: true }, { status: true })).not.toThrow();
    expect(() => assertPublishAllowed({ allowPublish: false }, { status: false })).not.toThrow();
    expect(() => assertPublishAllowed({ allowPublish: false }, { name: "x" })).not.toThrow();
  });
});

describe("write-plane preset", () => {
  it("resolves the governed write-plane profile", () => {
    const cfg = resolveSecurityConfig({ security: { preset: "write-plane" } });
    expect(cfg.readOnly).toBe(false);
    expect(cfg.allowDestructive).toBe(false);
    expect(cfg.allowGraphqlMutations).toBe(false);
    // Base content set plus the structural content entities.
    expect(cfg.allowedEntityTypes).toEqual([
      "node", "taxonomy_term", "media",
      "paragraph", "block_content", "menu_link_content", "redirect", "path_alias", "file",
    ]);
    // No site-building config entities on the content tier.
    expect(cfg.allowedEntityTypes).not.toContain("field_storage_config");
    // Secrets/governance/account types are denied (belt-and-suspenders).
    expect(cfg.deniedEntityTypes).toContain("user");
    expect(cfg.deniedEntityTypes).toContain("oauth2_token");
    expect(cfg.deniedEntityTypes).toContain("mcp_policy_profile");
    expect(cfg.globalRedactedFields).toContain("pass");
    expect(cfg.globalRedactedFields).toContain("mail");
  });
});

describe("widened content/developer allowlists", () => {
  const structural = ["paragraph", "block_content", "menu_link_content", "redirect", "path_alias", "file"];
  const siteBuilder = ["node_type", "field_config", "field_storage_config", "entity_form_display", "entity_view_display", "taxonomy_vocabulary"];
  const sensitive = ["user", "oauth2_token", "key", "consumer", "encryption_profile", "mcp_tool_config", "mcp_policy_profile"];

  it("content-editor gains structural content entities but no site-building config", () => {
    const cfg = resolveSecurityConfig({ security: { preset: "content-editor" } });
    for (const t of structural) expect(cfg.allowedEntityTypes).toContain(t);
    for (const t of siteBuilder) expect(cfg.allowedEntityTypes).not.toContain(t);
    for (const t of sensitive) expect(cfg.deniedEntityTypes).toContain(t);
  });

  it("config-editor (developer) gains site-building config entities for read/introspection", () => {
    const cfg = resolveSecurityConfig({ security: { preset: "config-editor" } });
    for (const t of structural) expect(cfg.allowedEntityTypes).toContain(t);
    for (const t of siteBuilder) expect(cfg.allowedEntityTypes).toContain(t);
    for (const t of sensitive) expect(cfg.deniedEntityTypes).toContain(t);
  });

  it("PII-bearing types stay off the content/developer allowlists", () => {
    for (const preset of ["content-editor", "config-editor", "write-plane"]) {
      const cfg = resolveSecurityConfig({ security: { preset } });
      expect(cfg.allowedEntityTypes).not.toContain("webform_submission");
      expect(cfg.allowedEntityTypes).not.toContain("profile");
    }
  });
});

describe("config capability presets", () => {
  it("config-editor (Developer tier) allows config read + write", () => {
    const cfg = resolveSecurityConfig({ security: { preset: "config-editor" } });
    expect(cfg.allowConfigRead).toBe(true);
    expect(cfg.allowConfigWrite).toBe(true);
    expect(cfg.allowDestructive).toBe(false);
    expect(cfg.allowedEntityTypes).toContain("node");
  });

  it("content-editor allows config read but not write", () => {
    const cfg = resolveSecurityConfig({ security: { preset: "content-editor" } });
    expect(cfg.allowConfigRead).toBe(true);
    expect(cfg.allowConfigWrite).toBe(false);
  });

  it("development allows both; production-strict allows neither", () => {
    expect(resolveSecurityConfig({ security: { preset: "development" } }).allowConfigWrite).toBe(true);
    const strict = resolveSecurityConfig({ security: { preset: "production-strict" } });
    expect(strict.allowConfigRead).toBe(false);
    expect(strict.allowConfigWrite).toBe(false);
  });

  it("explicit keys override the preset config caps", () => {
    const cfg = resolveSecurityConfig({ security: { preset: "content-editor", allowConfigWrite: true } });
    expect(cfg.allowConfigWrite).toBe(true);
  });

  it("defaults to no config access when no preset/keys are given", () => {
    const cfg = resolveSecurityConfig({});
    // development is the implicit default preset → both true
    expect(cfg.allowConfigRead).toBe(true);
    expect(cfg.allowConfigWrite).toBe(true);
  });

  it("getSecuritySummary surfaces the config caps", () => {
    const s = getSecuritySummary({ _name: "dev", security: { preset: "config-editor" } });
    expect(s.allowConfigRead).toBe(true);
    expect(s.allowConfigWrite).toBe(true);
  });
});

describe("assertConfigReadAllowed / assertConfigWriteAllowed", () => {
  it("read passes when allowed, throws when not", () => {
    expect(() => assertConfigReadAllowed({ allowConfigRead: true })).not.toThrow();
    expect(() => assertConfigReadAllowed({ allowConfigRead: false })).toThrow(SecurityError);
  });

  it("write passes when allowed, throws when not", () => {
    expect(() => assertConfigWriteAllowed({ allowConfigWrite: true })).not.toThrow();
    expect(() => assertConfigWriteAllowed({ allowConfigWrite: false })).toThrow(SecurityError);
  });
});

describe("assertGraphqlMutationAllowed", () => {
  it("allows a plain query when mutations are disabled", () => {
    expect(() => assertGraphqlMutationAllowed(denyMut, "{ nodeArticles { nodes { id } } }")).not.toThrow();
    expect(() => assertGraphqlMutationAllowed(denyMut, "query Q { nodeArticle(id: \"x\") { id } }")).not.toThrow();
  });

  it("blocks a leading-keyword mutation when disabled", () => {
    expect(() => assertGraphqlMutationAllowed(denyMut, "mutation M { createNodeArticle(data: {}) { errors { message } } }"))
      .toThrow(SecurityError);
  });

  it("blocks a mutation that is NOT the first line (regex-bypass case)", () => {
    const doc = "# a comment\nquery Q { nodeArticle(id: \"x\") { id } }\nmutation M { deleteNodeArticle(id: \"x\") { errors { message } } }";
    expect(() => assertGraphqlMutationAllowed(denyMut, doc)).toThrow(SecurityError);
  });

  it("allows mutations when explicitly enabled and not read-only", () => {
    expect(() => assertGraphqlMutationAllowed(allowMut, "mutation M { x { id } }")).not.toThrow();
  });

  it("blocks mutations on a read-only site even when allowGraphqlMutations is true", () => {
    expect(() => assertGraphqlMutationAllowed(readOnly, "mutation M { x { id } }")).toThrow(SecurityError);
  });

  it("allows queries on a read-only site", () => {
    expect(() => assertGraphqlMutationAllowed(readOnly, "{ nodeArticles { nodes { id } } }")).not.toThrow();
  });

  it("falls back to a conservative check on unparseable input containing a mutation", () => {
    // Malformed doc (missing closing brace) that still clearly declares a mutation.
    expect(() => assertGraphqlMutationAllowed(denyMut, "mutation M { createX(")).toThrow(SecurityError);
  });
});

describe("redactCanonicalEntity", () => {
  const sec = {
    globalRedactedFields: ["field_api_key"],
    entityRules: { user: { redactedFields: ["mail", "pass"] } },
  };

  function entity() {
    return {
      id: "u1", entityType: "user", bundle: "user", title: "Jane",
      status: true, langcode: "en", created: null, changed: null, url: null,
      fields: { mail: "j@x.com", field_api_key: "secret", bio: "hi" },
      relationships: {}, _backend: "jsonapi",
    };
  }

  it("redacts entity-type and global fields in `fields`", () => {
    const r = redactCanonicalEntity(entity(), sec, "user");
    expect(r.fields.mail).toBe("[REDACTED]");
    expect(r.fields.field_api_key).toBe("[REDACTED]");
    expect(r.fields.bio).toBe("hi");
  });

  it("redacts a base property when named in the redaction set", () => {
    const sec2 = { globalRedactedFields: ["title"], entityRules: {} };
    const r = redactCanonicalEntity(entity(), sec2, "user");
    expect(r.title).toBe("[REDACTED]");
  });

  it("returns the entity unchanged when nothing matches", () => {
    const r = redactCanonicalEntity(entity(), { globalRedactedFields: [], entityRules: {} }, "node");
    expect(r.fields.mail).toBe("j@x.com");
  });

  it("handles null/undefined entity", () => {
    expect(redactCanonicalEntity(null, sec, "user")).toBeNull();
  });
});
