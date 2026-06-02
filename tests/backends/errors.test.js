import { describe, it, expect } from "vitest";
import { BackendCapabilityError, BackendResolutionError } from "../../src/lib/backends/errors.js";

describe("backend errors", () => {
  it("BackendCapabilityError carries name and message", () => {
    const e = new BackendCapabilityError("no writes");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BackendCapabilityError");
    expect(e.message).toBe("no writes");
  });

  it("BackendResolutionError carries name and message", () => {
    const e = new BackendResolutionError("no backend");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BackendResolutionError");
    expect(e.message).toBe("no backend");
  });
});
