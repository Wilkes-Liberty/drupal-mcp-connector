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

  it("keys from the Paladin twin and never from a caller field", () => {
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

  it("admits past the cap when the bound is removed (red evidence)", () => {
    setInFlightCapGuard(false);
    expect(IN_FLIGHT_CAP_GUARD.enforced).toBe(false);
    const registry = createInFlightRegistry({ maxEntries: 1 });
    registry.begin(inFlightKeysFromIdentity(identity));
    expect(() => registry.begin(inFlightKeysFromIdentity({
      ...identity, sub: "human-2",
    }))).not.toThrow();
    expect(registry.size()).toBe(2);
  });

  it("does not cancel the world on an empty selector", () => {
    const registry = createInFlightRegistry({ maxEntries: 4 });
    registry.begin(inFlightKeysFromIdentity(identity));
    expect(registry.cancel({})).toBe(0);
    expect(registry.size()).toBe(1);
  });

  it("defaults to a finite cap", () => {
    expect(IN_FLIGHT_MAX_ENTRIES).toBe(128);
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
