import { describe, it, expect } from "vitest";
import { applyClientFilters, applyClientSort } from "../../src/lib/backends/graphql-filter.js";

const entities = [
  { id: "a", title: "Alpha", status: true, created: "2025-01-01", fields: { wordCount: 100 } },
  { id: "b", title: "Beta", status: false, created: "2025-03-01", fields: { wordCount: 500 } },
  { id: "c", title: "Gamma alpha", status: true, created: "2025-02-01", fields: { wordCount: 300 } },
];

describe("applyClientFilters", () => {
  it("eq on a base field", () => {
    expect(applyClientFilters(entities, [{ field: "status", op: "eq", value: true }]).map((e) => e.id)).toEqual(["a", "c"]);
  });
  it("contains is case-insensitive on a base field", () => {
    expect(applyClientFilters(entities, [{ field: "title", op: "contains", value: "alpha" }]).map((e) => e.id)).toEqual(["a", "c"]);
  });
  it("lt on a custom field", () => {
    expect(applyClientFilters(entities, [{ field: "wordCount", op: "lt", value: 400 }]).map((e) => e.id)).toEqual(["a", "c"]);
  });
  it("in on id", () => {
    expect(applyClientFilters(entities, [{ field: "id", op: "in", value: ["a", "b"] }]).map((e) => e.id)).toEqual(["a", "b"]);
  });
  it("combines filters with AND", () => {
    expect(applyClientFilters(entities, [{ field: "status", op: "eq", value: true }, { field: "wordCount", op: "gt", value: 200 }]).map((e) => e.id)).toEqual(["c"]);
  });
});

describe("applyClientSort", () => {
  it("sorts ascending by created", () => {
    expect(applyClientSort(entities, [{ field: "created", dir: "asc" }]).map((e) => e.id)).toEqual(["a", "c", "b"]);
  });
  it("sorts descending by a custom field", () => {
    expect(applyClientSort(entities, [{ field: "wordCount", dir: "desc" }]).map((e) => e.id)).toEqual(["b", "c", "a"]);
  });
});
