import { describe, expect, it } from "vitest";
import {
  createLocalPolicyEnforcement,
  EMERGENCY_DIGEST,
} from "../../src/lib/policy-enforcement.js";
import { digestOf } from "../../src/lib/policy-enforcement.js";

describe("createLocalPolicyEnforcement (#253 / DEV-125)", () => {
  const now = () => 1_700_000_000;

  it("cannot mint, verify, or activate without a signing key", () => {
    const offline = createLocalPolicyEnforcement({ signingKey: null, now });
    expect(offline.canSeal()).toBe(false);
    expect(offline.mint(["delete"])).toBeNull();
    expect(offline.activate({ digest: "aa".repeat(32), seal: "hmac-sha256:x" }))
      .toEqual({ ok: false, reason: "unverified" });
    offline.emergencyDeny();
    expect(offline.activeDigest()).toBe(EMERGENCY_DIGEST);
    expect(offline.mint(["create"])).toBeNull();
  });

  it("mints a sealed document whose digest is stable across key order", () => {
    const registry = createLocalPolicyEnforcement({ signingKey: "secret", now });
    const bundle = registry.mint(["delete"], 3600);
    expect(bundle.digest).toMatch(/^[0-9a-f]{64}$/);
    const a = { v: 1, denials: { operations: ["delete"] }, id: "x", issued: 1, expires: 10 };
    const b = { expires: 10, id: "x", issued: 1, v: 1, denials: { operations: ["delete"] } };
    expect(digestOf(a)).toBe(digestOf(b));
    expect(registry.verify(bundle.toArray()).digest).toBe(bundle.digest);
  });

  it("rejects a tampered body, a bad seal, and an expired document", () => {
    const registry = createLocalPolicyEnforcement({ signingKey: "secret", now });
    const bundle = registry.mint(["delete"], 3600);
    const tampered = bundle.toArray();
    tampered.denials = { operations: [] };
    expect(registry.verify(tampered)).toBeNull();

    const recut = bundle.toArray();
    recut.seal = "hmac-sha256:" + "00".repeat(32);
    expect(registry.verify(recut)).toBeNull();

    const expired = createLocalPolicyEnforcement({
      signingKey: "secret",
      now: () => 1_700_000_000,
    }).mint(["delete"], 1);
    const later = createLocalPolicyEnforcement({
      signingKey: "secret",
      now: () => 1_700_000_010,
    });
    later.mint(["unused"], 10);
    expect(later.verify(expired.toArray())).toBeNull();
  });

  it("activates the exact digest and rolls back to last-known-good", () => {
    const registry = createLocalPolicyEnforcement({ signingKey: "secret", now });
    const first = registry.mint(["delete"], 3600);
    expect(registry.activate(first.toArray())).toEqual({
      ok: true,
      digest: first.digest,
      attested: true,
    });
    expect(registry.activeDigest()).toBe(first.digest);

    const second = registry.mint(["create"], 3600);
    expect(registry.activate(second.toArray()).digest).toBe(second.digest);
    expect(registry.rollback().digest).toBe(first.digest);
    expect(registry.activeDigest()).toBe(first.digest);
  });

  it("lets a local deny win, and cites the digest on bundle deny", () => {
    const registry = createLocalPolicyEnforcement({ signingKey: "secret", now });
    const bundle = registry.mint(["delete"], 3600);
    registry.activate(bundle.toArray());
    expect(registry.simulate("delete", true)).toEqual({
      allow: false, reason: "local_deny", digest: bundle.digest,
    });
    expect(registry.simulate("delete", false)).toEqual({
      allow: false, reason: "bundle_deny", digest: bundle.digest,
    });
    expect(registry.simulate("view", false)).toEqual({
      allow: true, reason: "allow", digest: bundle.digest,
    });
  });

  it("revokes the active digest into emergency deny without minting", () => {
    const registry = createLocalPolicyEnforcement({ signingKey: "secret", now });
    const bundle = registry.mint(["delete"], 3600);
    registry.activate(bundle.toArray());
    registry.revoke(bundle.digest);
    expect(registry.activeDigest()).toBe(EMERGENCY_DIGEST);
    expect(registry.verify(bundle.toArray())).toBeNull();
    expect(registry.simulate("view", false)).toMatchObject({
      allow: false, reason: "emergency_deny",
    });
    expect(registry.mint(["create"]).digest).not.toBe(EMERGENCY_DIGEST);
  });
});
