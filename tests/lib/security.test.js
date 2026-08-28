import { describe, it, expect } from "vitest";
import { assertGraphqlMutationAllowed, SecurityError } from "../../src/lib/security.js";
import { redactCanonicalEntity, redactResource, resolveSecurityConfig } from "../../src/lib/security.js";
import { assertConfigReadAllowed, assertConfigWriteAllowed, getSecuritySummary } from "../../src/lib/security.js";
import { assertPublishAllowed, isPublishBearing } from "../../src/lib/security.js";
import { assertConfigScope, hasScope } from "../../src/lib/security.js";

// allowGraphql required for any GraphQL path (#142); mutations need both flags.
const allowMut = { allowGraphql: true, allowGraphqlMutations: true, readOnly: false };
const denyMut = { allowGraphql: true, allowGraphqlMutations: false, readOnly: false };
const readOnly = { allowGraphql: true, allowGraphqlMutations: true, readOnly: true };
const noGraphql = { allowGraphql: false, allowGraphqlMutations: false, readOnly: false };

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

  it("throws on moderation_state:published when allowPublish is false (#139)", () => {
    expect(() => assertPublishAllowed({ allowPublish: false }, { moderation_state: "published" })).toThrow(/allowPublish/);
    expect(isPublishBearing({ moderation_state: "draft" })).toBe(false);
    expect(isPublishBearing({ moderation_state: "published" })).toBe(true);
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

  it("auditor and production-strict apply SENSITIVE_DENY (#140)", () => {
    for (const preset of ["auditor", "production-strict"]) {
      const denied = resolveSecurityConfig({ security: { preset } }).deniedEntityTypes;
      expect(denied).toContain("user");
      expect(denied).toContain("oauth2_token");
      expect(denied).toContain("key");
      expect(denied).toContain("mcp_policy_profile");
    }
  });

  it("explicit keys override the preset config caps", () => {
    const cfg = resolveSecurityConfig({ security: { preset: "content-editor", allowConfigWrite: true } });
    expect(cfg.allowConfigWrite).toBe(true);
  });

  it("defaults to production-strict when no preset/keys are given (#140)", () => {
    const cfg = resolveSecurityConfig({});
    // Least privilege: production-strict, not development
    expect(cfg.readOnly).toBe(true);
    expect(cfg.allowConfigRead).toBe(false);
    expect(cfg.allowConfigWrite).toBe(false);
    expect(cfg.allowPublish).toBe(false);
    expect(cfg.allowGraphql).toBe(false);
    expect(cfg.deniedEntityTypes).toContain("user");
  });

  it("requires explicit development preset for open mode (#140)", () => {
    const open = resolveSecurityConfig({ security: { preset: "development" } });
    expect(open.readOnly).toBe(false);
    expect(open.allowPublish).toBe(true);
    expect(open.allowGraphql).toBe(true);
  });

  it("disables GraphQL outside development unless allowGraphql is set (#142)", () => {
    for (const preset of ["content-editor", "auditor", "production-strict", "write-plane"]) {
      expect(resolveSecurityConfig({ security: { preset } }).allowGraphql).toBe(false);
    }
    expect(resolveSecurityConfig({ security: { preset: "content-editor", allowGraphql: true } }).allowGraphql).toBe(true);
  });

  it("getSecuritySummary surfaces the config caps", () => {
    const s = getSecuritySummary({ _name: "dev", security: { preset: "config-editor" } });
    expect(s.allowConfigRead).toBe(true);
    expect(s.allowConfigWrite).toBe(true);
  });

  it("passes declaredCeiling and readBudgets through from site security", () => {
    const cfg = resolveSecurityConfig({
      security: { preset: "content-editor", declaredCeiling: "internal", readBudgets: { results: 10 } },
    });
    expect(cfg.declaredCeiling).toBe("internal");
    expect(cfg.readBudgets).toEqual({ results: 10 });
    const s = getSecuritySummary({
      _name: "prod",
      security: { preset: "content-editor", declaredCeiling: "internal" },
    });
    expect(s.declaredCeiling).toBe("internal");
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
  it("blocks all GraphQL when allowGraphql is false (#142)", () => {
    expect(() => assertGraphqlMutationAllowed(noGraphql, "{ nodeArticles { nodes { id } } }")).toThrow(/allowGraphql/);
  });

  it("allows a plain query when mutations are disabled but GraphQL is on", () => {
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

  it("redacts the numeric node id when configured", () => {
    const node = {
      ...entity(),
      entityType: "node",
      bundle: "article",
      fields: { drupal_internal__nid: 42 },
    };
    const nidRedactionPolicy = { globalRedactedFields: [], entityRules: { node: { redactedFields: ["drupal_internal__nid"] } } };
    const r = redactCanonicalEntity(node, nidRedactionPolicy, "node");
    expect(r.fields.drupal_internal__nid).toBe("[REDACTED]");
  });

  it("returns the entity unchanged when nothing matches", () => {
    const r = redactCanonicalEntity(entity(), { globalRedactedFields: [], entityRules: {} }, "node");
    expect(r.fields.mail).toBe("j@x.com");
  });

  it("handles null/undefined entity", () => {
    expect(redactCanonicalEntity(null, sec, "user")).toBeNull();
  });
});

describe("hasScope — the empty-scope bypass is closed for governed setups (#180)", () => {
  const governed = (over = {}) => ({
    _name: "prod",
    baseUrl: "https://drupal.example.com",
    requireGovernance: true,
    oauth: { clientId: "content-agent", scopes: [], grant: "client_credentials" },
    ...over,
  });

  it("denies every scope when a governed site names no scopes", () => {
    expect(hasScope(governed(), "mcp_config")).toBe(false);
    expect(hasScope(governed(), "mcp_write")).toBe(false);
    expect(hasScope(governed(), "mcp_read")).toBe(false);
  });

  it("denies when the oauth block omits the scopes key entirely", () => {
    const site = governed({ oauth: { clientId: "content-agent", grant: "client_credentials" } });
    expect(hasScope(site, "mcp_read")).toBe(false);
  });

  it("honours a named scope list on a governed site, both ways", () => {
    const site = governed({ oauth: { clientId: "content-agent", scopes: ["mcp_read", "mcp_write"] } });
    expect(hasScope(site, "mcp_write")).toBe(true);
    expect(hasScope(site, "mcp_config")).toBe(false);
  });

  it("treats an OAuth site as a governed setup even without requireGovernance", () => {
    const site = { _name: "s", baseUrl: "https://drupal.example.com", oauth: { clientId: "a", scopes: [] } };
    expect(hasScope(site, "mcp_config")).toBe(false);
  });

  it("leaves an ungoverned token/anonymous site permissive (no OAuth, no governance claim)", () => {
    const apiTokenSite = { _name: "legacy", baseUrl: "https://drupal.example.com", apiToken: "t" };
    expect(hasScope(apiTokenSite, "mcp_config")).toBe(true);
    expect(hasScope(undefined, "mcp_read")).toBe(true);
  });

  it("denies a scope-gated config tool on a governed site with empty scopes", () => {
    expect(() => assertConfigScope(governed(), "config:set system.site")).toThrow(SecurityError);
    const scoped = governed({ oauth: { clientId: "dev-agent", scopes: ["mcp_read", "mcp_config"] } });
    expect(() => assertConfigScope(scoped, "config:set system.site")).not.toThrow();
  });
});
