import { describe, expect, it } from "vitest";
import { assertionLabel, isPinnedLabel, labelMatches } from "./pinned-label.js";

describe("pinned assertion labels (a-2 / c-1)", () => {
  it("matches only the complete label, never a substring", () => {
    const failure = "GET /health: status: expected 401 to be 200\n  at …";
    expect(assertionLabel(failure)).toBe("GET /health: status: expected 401 to be 200");
    expect(labelMatches(failure, "GET /health: status")).toBe(true);
    expect(labelMatches("GET /health: status", "GET /health: status")).toBe(true);
    // A broad pin must not absorb a different assertion, and a label's own
    // leading segment is not a label.
    expect(labelMatches(failure, "status")).toBe(false);
    expect(labelMatches(failure, "GET /health")).toBe(false);
    expect(labelMatches("GET /health: body: expected 'x' to be 'y'", "GET /health: status")).toBe(false);
    expect(labelMatches(failure, " ")).toBe(false);
    expect(labelMatches(failure, "")).toBe(false);
    expect(labelMatches(failure, undefined)).toBe(false);
    // A longer pin does not match a shorter label either.
    expect(labelMatches("GET /health: status: expected 1 to be 2", "GET /health: status: expected")).toBe(false);
  });

  it("rejects blank pins", () => {
    expect(isPinnedLabel("")).toBe(false);
    expect(isPinnedLabel("   ")).toBe(false);
    expect(isPinnedLabel(null)).toBe(false);
    expect(isPinnedLabel("POST initialize: status")).toBe(true);
  });
});
