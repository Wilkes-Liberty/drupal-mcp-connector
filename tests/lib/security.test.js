import { describe, it, expect } from "vitest";
import { assertGraphqlMutationAllowed, SecurityError } from "../../src/lib/security.js";
import { redactCanonicalEntity, redactResource, resolveSecurityConfig } from "../../src/lib/security.js";

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

describe("write-plane preset", () => {
  it("resolves the governed write-plane profile", () => {
    const cfg = resolveSecurityConfig({ security: { preset: "write-plane" } });
    expect(cfg.readOnly).toBe(false);
    expect(cfg.allowDestructive).toBe(false);
    expect(cfg.allowGraphqlMutations).toBe(false);
    expect(cfg.allowedEntityTypes).toEqual(["node", "taxonomy_term", "media"]);
    expect(cfg.deniedEntityTypes).toEqual(["user"]);
    expect(cfg.globalRedactedFields).toContain("pass");
    expect(cfg.globalRedactedFields).toContain("mail");
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
