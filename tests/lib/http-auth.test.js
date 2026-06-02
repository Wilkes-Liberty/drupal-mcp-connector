import { describe, it, expect } from "vitest";
import { makeBearerCheck } from "../../src/lib/http-auth.js";

describe("makeBearerCheck", () => {
  it("disabled (no token) accepts anything", () => {
    const ok = makeBearerCheck("");
    expect(ok(undefined)).toBe(true);
    expect(ok("Bearer whatever")).toBe(true);
  });
  it("accepts the matching bearer token", () => {
    const ok = makeBearerCheck("s3cret");
    expect(ok("Bearer s3cret")).toBe(true);
  });
  it("rejects a wrong / missing / malformed token", () => {
    const ok = makeBearerCheck("s3cret");
    expect(ok("Bearer nope")).toBe(false);
    expect(ok("s3cret")).toBe(false);       // missing "Bearer "
    expect(ok(undefined)).toBe(false);
    expect(ok("Bearer s3cre")).toBe(false);  // length mismatch
  });
});
