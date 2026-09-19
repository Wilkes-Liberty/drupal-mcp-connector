import { describe, it, expect } from "vitest";
import { dryRunChecks, PREFLIGHT_NONE, PREFLIGHT_CORE_GUARD, PREFLIGHT_SENTINEL_DRAFT } from "../../src/lib/dry-run-checks.js";

/**
 * A dryRun preview must say what was checked. A preview that returns without
 * a refusal reads as "this write will work", and that is only true for the
 * checks that ran (#336).
 */
describe("dryRunChecks", () => {
  it("marks field access and validation checked only for the Sentinel draft preflight", () => {
    const out = dryRunChecks({ operation: "update", preflight: PREFLIGHT_SENTINEL_DRAFT });
    expect(out.checks).toEqual({
      serverPreflight: "sentinel_draft",
      connectorPolicy: "checked",
      entityAccess: "checked",
      revisionGuard: "checked",
      fieldAccess: "checked",
      entityValidation: "checked",
    });
    expect(out).not.toHaveProperty("caveat");
  });

  it("says the core guard probe carries no fields", () => {
    const out = dryRunChecks({ operation: "update", preflight: PREFLIGHT_CORE_GUARD });
    expect(out.checks).toMatchObject({
      serverPreflight: "core_patch_guard",
      entityAccess: "checked",
      revisionGuard: "checked",
      fieldAccess: "not_checked",
      entityValidation: "not_checked",
    });
    expect(out.caveat).toMatch(/field access/i);
    expect(out.caveat).toMatch(/validation/i);
    expect(out.caveat).toMatch(/NOT checked/);
  });

  it("says Drupal evaluated nothing when no preflight ran", () => {
    for (const operation of ["create", "update", "delete"]) {
      const out = dryRunChecks({ operation, preflight: PREFLIGHT_NONE });
      expect(out.checks).toEqual({
        serverPreflight: "none",
        connectorPolicy: "checked",
        entityAccess: "not_checked",
        revisionGuard: "not_checked",
        fieldAccess: "not_checked",
        entityValidation: "not_checked",
      });
      expect(out.caveat).toMatch(/NOT checked/);
    }
    expect(dryRunChecks({ operation: "delete", preflight: PREFLIGHT_NONE }).caveat).toMatch(/delete access/i);
  });

  it("fails closed on an unknown or missing preflight: nothing is reported checked", () => {
    for (const preflight of [undefined, null, "sentinel", "SENTINEL_DRAFT", {}]) {
      const out = dryRunChecks({ operation: "update", preflight });
      expect(out.checks.serverPreflight).toBe("none");
      expect(out.checks.fieldAccess).toBe("not_checked");
      expect(out.caveat).toBeTruthy();
    }
  });

  it("never reports a bare writable flag", () => {
    for (const preflight of [PREFLIGHT_NONE, PREFLIGHT_CORE_GUARD, PREFLIGHT_SENTINEL_DRAFT]) {
      expect(dryRunChecks({ operation: "update", preflight })).not.toHaveProperty("writable");
    }
  });
});
