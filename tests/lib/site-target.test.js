import { describe, expect, it } from "vitest";
import { SecurityError } from "../../src/lib/security.js";
import { isWriteLikeCall, isWriteLikeTool } from "../../src/lib/operations.js";
import {
  SITE_PARAM,
  assertExplicitSiteForWrite,
  withResolvedTarget,
} from "../../src/lib/site-target.js";

const dev = {
  site: { _name: "dev", baseUrl: "https://dev.example.com" },
  source: "default",
  name: "dev",
};

describe("isWriteLikeTool / isWriteLikeCall", () => {
  it("treats prefix writes, generic entity writes, and GraphQL mutations as writes", () => {
    expect(isWriteLikeTool("drupal_create_node")).toBe(true);
    expect(isWriteLikeTool("drupal_update_node")).toBe(true);
    expect(isWriteLikeTool("drupal_delete_node")).toBe(true);
    expect(isWriteLikeTool("drupal_entity_create")).toBe(true);
    expect(isWriteLikeTool("drupal_entity_update")).toBe(true);
    expect(isWriteLikeTool("drupal_entity_delete")).toBe(true);
    expect(isWriteLikeTool("drupal_config_set")).toBe(true);
    expect(isWriteLikeTool("drupal_list_nodes")).toBe(false);
    expect(isWriteLikeTool("drupal_graphql")).toBe(false);

    expect(isWriteLikeCall("drupal_graphql", { query: "query { node { id } }" })).toBe(false);
    expect(isWriteLikeCall("drupal_graphql", { query: "mutation { createNode { id } }" })).toBe(true);
    expect(isWriteLikeCall("drupal_list_nodes", {})).toBe(false);
  });
});

describe("withResolvedTarget", () => {
  it("attaches whoami-shaped _target to an object payload", () => {
    const out = withResolvedTarget({ total: 1, nodes: [{ id: "n1", _backend: "jsonapi" }] }, dev);
    expect(out._target).toEqual({
      name: "dev",
      baseUrl: "https://dev.example.com",
      source: "default",
    });
    expect(out.nodes[0]).toEqual({ id: "n1", _backend: "jsonapi" });
  });

  it("wraps an array payload so _target survives JSON.stringify", () => {
    const out = withResolvedTarget([{ id: "n1" }], { ...dev, source: "hint" });
    expect(out).toEqual({
      items: [{ id: "n1" }],
      _target: { name: "dev", baseUrl: "https://dev.example.com", source: "hint" },
    });
    expect(JSON.parse(JSON.stringify(out))._target.source).toBe("hint");
  });

  it("leaves the payload alone when there is no single resolved target", () => {
    expect(withResolvedTarget({ sites: ["dev"] }, null)).toEqual({ sites: ["dev"] });
  });
});

describe("assertExplicitSiteForWrite", () => {
  const sites = ["dev", "prod"];

  it("refuses a silent-default write on a multi-site config", () => {
    expect(() => assertExplicitSiteForWrite("drupal_create_node", {}, dev, sites))
      .toThrow(SecurityError);
    expect(() => assertExplicitSiteForWrite("drupal_create_node", {}, dev, sites))
      .toThrow(/explicit site/);
    expect(() => assertExplicitSiteForWrite("drupal_create_node", {}, dev, sites))
      .toThrow(/dev\.example\.com/);
  });

  it("allows a read on the default and a write that named the site", () => {
    expect(() => assertExplicitSiteForWrite("drupal_list_nodes", {}, dev, sites)).not.toThrow();
    expect(() => assertExplicitSiteForWrite(
      "drupal_create_node",
      { site: "dev" },
      { ...dev, source: "hint" },
      sites,
    )).not.toThrow();
  });

  it("allows a defaulted write when only one site is configured", () => {
    expect(() => assertExplicitSiteForWrite("drupal_create_node", {}, dev, ["dev"])).not.toThrow();
  });
});

describe("SITE_PARAM", () => {
  it("warns that omit is not production and that writes need an explicit site", () => {
    expect(SITE_PARAM.type).toBe("string");
    expect(SITE_PARAM.description).toMatch(/defaultSite/);
    expect(SITE_PARAM.description).toMatch(/not production/i);
    expect(SITE_PARAM.description).toMatch(/_target/);
  });
});
