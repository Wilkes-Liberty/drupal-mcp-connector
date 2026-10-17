/**
 * Bounded in-flight registry. A kill cancels matching calls. A full
 * registry fails closed. The cap test includes a red run with the bound
 * removed so it can fail.
 */

import { afterEach, describe, expect, it } from "vitest";
import { callTool } from "../../src/lib/dispatch.js";
import {
  IN_FLIGHT_CAP_GUARD,
  IN_FLIGHT_MAX_ENTRIES,
  IN_FLIGHT_MAX_PER_PRINCIPAL,
  createInFlightRegistry,
  inFlightKeysFromIdentity,
  setInFlightCapGuard,
  setInFlightRegistry,
} from "../../src/lib/in-flight.js";
import { GENERIC_PRINCIPAL_REFUSAL } from "../../src/lib/principal-context.js";
import { SecurityError } from "../../src/lib/security.js";

const identity = {
  iss: "https://idp.example/realms/agents",
  sub: "human-1",
  azp: "agent-client",
  tenant: "tenant-a",
};

describe("in-flight registry", () => {
  afterEach(() => {
    setInFlightCapGuard(true);
    setInFlightRegistry(null);
  });

  it("keys from the principal-key twin and never from a caller field", () => {
    expect(inFlightKeysFromIdentity(identity)).toEqual({
      principalKey: "https://idp.example/realms/agents|human-1|agent-client",
      humanKey: "https://idp.example/realms/agents|human-1",
      tenant: "tenant-a",
    });
    expect(inFlightKeysFromIdentity({ sub: "human-1", clientId: "nope" })).toBeNull();
  });

  it("cancels in-flight calls for a principal, human, or tenant", () => {
    const registry = createInFlightRegistry({ maxEntries: 8 });
    const a = registry.begin(inFlightKeysFromIdentity(identity));
    const other = registry.begin(inFlightKeysFromIdentity({
      ...identity, sub: "human-2", tenant: "tenant-b",
    }));
    expect(registry.size()).toBe(2);
    expect(registry.cancel({ principalKey: inFlightKeysFromIdentity(identity).principalKey })).toBe(1);
    expect(a.signal.aborted).toBe(true);
    expect(a.signal.reason).toBeInstanceOf(SecurityError);
    expect(a.signal.reason.message).toBe(GENERIC_PRINCIPAL_REFUSAL);
    expect(other.signal.aborted).toBe(false);
    expect(registry.cancel({ tenant: "tenant-b" })).toBe(1);
    expect(other.signal.aborted).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("fails closed when the registry is full", () => {
    const registry = createInFlightRegistry({ maxEntries: 1 });
    registry.begin(inFlightKeysFromIdentity(identity));
    expect(() => registry.begin(inFlightKeysFromIdentity({
      ...identity, sub: "human-2",
    }))).toThrow(SecurityError);
    expect(() => registry.begin(inFlightKeysFromIdentity({
      ...identity, sub: "human-2",
    }))).toThrow(GENERIC_PRINCIPAL_REFUSAL);
  });

  it("admits past the global cap when that bound is removed (red evidence)", () => {
    setInFlightCapGuard(false, "global");
    expect(IN_FLIGHT_CAP_GUARD.global).toBe(false);
    expect(IN_FLIGHT_CAP_GUARD.perPrincipal).toBe(true);
    const registry = createInFlightRegistry({ maxEntries: 1, maxPerPrincipal: 1 });
    registry.begin(inFlightKeysFromIdentity(identity));
    expect(() => registry.begin(inFlightKeysFromIdentity({
      ...identity, sub: "human-2",
    }))).not.toThrow();
    expect(registry.size()).toBe(2);
    expect(() => registry.begin(inFlightKeysFromIdentity(identity))).toThrow(GENERIC_PRINCIPAL_REFUSAL);
  });

  it("does not cancel the world on an empty selector", () => {
    const registry = createInFlightRegistry({ maxEntries: 4 });
    registry.begin(inFlightKeysFromIdentity(identity));
    expect(registry.cancel({})).toBe(0);
    expect(registry.size()).toBe(1);
  });

  it("defaults to a finite cap", () => {
    expect(IN_FLIGHT_MAX_ENTRIES).toBe(128);
    expect(IN_FLIGHT_MAX_PER_PRINCIPAL).toBe(16);
  });

  it("fails closed at the per-principal cap without denying other principals", () => {
    const registry = createInFlightRegistry({ maxEntries: 8, maxPerPrincipal: 1 });
    registry.begin(inFlightKeysFromIdentity(identity));
    expect(() => registry.begin(inFlightKeysFromIdentity(identity))).toThrow(GENERIC_PRINCIPAL_REFUSAL);
    expect(() => registry.begin(inFlightKeysFromIdentity({
      ...identity, sub: "human-2",
    }))).not.toThrow();
    expect(registry.size()).toBe(2);
  });

  it("admits past the per-principal cap when that bound is removed (red evidence)", () => {
    setInFlightCapGuard(false, "perPrincipal");
    expect(IN_FLIGHT_CAP_GUARD.perPrincipal).toBe(false);
    expect(IN_FLIGHT_CAP_GUARD.global).toBe(true);
    const registry = createInFlightRegistry({ maxEntries: 2, maxPerPrincipal: 1 });
    registry.begin(inFlightKeysFromIdentity(identity));
    expect(() => registry.begin(inFlightKeysFromIdentity(identity))).not.toThrow();
    expect(registry.size()).toBe(2);
    expect(() => registry.begin(inFlightKeysFromIdentity({
      ...identity, sub: "human-2",
    }))).toThrow(GENERIC_PRINCIPAL_REFUSAL);
  });

  it("returns a generic deny envelope from tools/call when the registry is full", async () => {
    const registry = createInFlightRegistry({ maxEntries: 1 });
    setInFlightRegistry(registry);
    registry.begin(inFlightKeysFromIdentity(identity));
    const result = await callTool("drupal_get_node", { site: "production" }, { identity });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`Access denied: ${GENERIC_PRINCIPAL_REFUSAL}`);
    expect(result.content[0].text).not.toMatch(/human-1|agent-client|tenant-a/);
  });
});
