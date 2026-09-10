import { describe, it, expect } from "vitest";
import { normalizeAlias, isPositiveNid, PATH_ALIAS_ENTITY_TYPE } from "../../src/lib/path-alias.js";

describe("normalizeAlias", () => {
  it("trims, adds a leading slash, and drops a trailing slash", () => {
    expect(normalizeAlias("  capabilities/intel/ ")).toBe("/capabilities/intel");
    expect(normalizeAlias("/keep-me")).toBe("/keep-me");
    expect(normalizeAlias("/")).toBe("/");
    expect(normalizeAlias("")).toBeNull();
    expect(normalizeAlias(null)).toBeNull();
  });
});

describe("isPositiveNid", () => {
  it("accepts positive integers only", () => {
    expect(isPositiveNid(44)).toBe(true);
    expect(isPositiveNid("9")).toBe(true);
    expect(isPositiveNid(0)).toBe(false);
    expect(isPositiveNid(-1)).toBe(false);
    expect(isPositiveNid("x")).toBe(false);
    expect(isPositiveNid(null)).toBe(false);
  });
});

describe("PATH_ALIAS_ENTITY_TYPE", () => {
  it("is the JSON:API path_alias bundle", () => {
    expect(PATH_ALIAS_ENTITY_TYPE).toBe("path_alias");
  });
});
