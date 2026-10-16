/**
 * DEV-846: re-introspect before a governed write commits. Inactive or
 * killed tokens abort with a generic deny. The 8s ready cache must not
 * mask a kill. Deny tests include a red run with the guard removed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { READY_PROBE_CACHE_MS } from "../../src/lib/ops-ready.js";
import {
  WRITE_REINTROSPECT_GUARD,
  assertLiveTokenForGovernedWrite,
  introspectionAllowsWrite,
  setWriteIntrospectUsesReadyCache,
  setWriteReintrospectGuard,
} from "../../src/lib/write-introspect.js";
import { GENERIC_PRINCIPAL_REFUSAL } from "../../src/lib/principal-context.js";
import { runWithIdentity } from "../../src/lib/principal.js";
import { SecurityError } from "../../src/lib/security.js";
import { createInFlightRegistry, setInFlightRegistry } from "../../src/lib/in-flight.js";
import { drupalFetch } from "../../src/lib/drupal-fetch.js";

vi.mock("node-fetch", () => ({ default: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) }));
import fetch from "node-fetch";

const identity = {
  iss: "https://idp.example/realms/agents",
  sub: "human-1",
  azp: "agent-client",
  tenant: "tenant-a",
  scopes: ["mcp_write"],
};

describe("introspectionAllowsWrite", () => {
  it("admits only active, not-killed bodies", () => {
    expect(introspectionAllowsWrite({ active: true })).toBe(true);
    expect(introspectionAllowsWrite({ active: false })).toBe(false);
    expect(introspectionAllowsWrite({ active: true, killed: true })).toBe(false);
    expect(introspectionAllowsWrite(null)).toBe(false);
    expect(READY_PROBE_CACHE_MS).toBe(8000);
  });
});

describe("DEV-846 write re-introspect", () => {
  afterEach(() => {
    setWriteReintrospectGuard(true);
    setWriteIntrospectUsesReadyCache(false);
    setInFlightRegistry(null);
  });

  it("aborts a killed or inactive token with a generic deny and no identity leakage", async () => {
    const introspect = vi.fn(async () => ({ active: false, killed: true, sub: "human-1" }));
    await expect(runWithIdentity(identity, () => assertLiveTokenForGovernedWrite({
      bearer: "tok-live",
      introspect,
      identity,
    }), { surface: "network", bearer: "tok-live", introspect })).rejects.toThrow(SecurityError);
    try {
      await runWithIdentity(identity, () => assertLiveTokenForGovernedWrite({
        bearer: "tok-live",
        introspect,
        identity,
      }), { surface: "network", bearer: "tok-live", introspect });
    } catch (err) {
      expect(err.message).toBe(GENERIC_PRINCIPAL_REFUSAL);
      expect(err.message).not.toMatch(/human-1|killed|tenant-a|tok-live/);
    }
  });

  it("admits an active token and does not consult a ready-cache hit", async () => {
    const introspect = vi.fn(async () => ({ active: true }));
    await runWithIdentity(identity, () => assertLiveTokenForGovernedWrite({
      bearer: "tok-live",
      introspect,
      identity,
      readyCache: { active: true },
    }), { surface: "network", bearer: "tok-live", introspect });
    expect(introspect).toHaveBeenCalledTimes(1);
  });

  it("lets a kill through when the guard is removed (red evidence)", async () => {
    setWriteReintrospectGuard(false);
    expect(WRITE_REINTROSPECT_GUARD.required).toBe(false);
    const introspect = vi.fn(async () => ({ active: false, killed: true }));
    await expect(assertLiveTokenForGovernedWrite({
      bearer: "tok-live",
      introspect,
      identity,
    })).resolves.toBeUndefined();
    expect(introspect).not.toHaveBeenCalled();
  });

  it("masks a kill when the 8s ready cache is consulted (red evidence)", async () => {
    setWriteIntrospectUsesReadyCache(true);
    const introspect = vi.fn(async () => ({ active: false, killed: true }));
    await expect(assertLiveTokenForGovernedWrite({
      bearer: "tok-live",
      introspect,
      identity,
      readyCache: { active: true },
    })).resolves.toBeUndefined();
    expect(introspect).not.toHaveBeenCalled();
  });

  it("re-introspects before a JSON:API write commits and cancels in-flight work", async () => {
    const registry = createInFlightRegistry({ maxEntries: 8 });
    setInFlightRegistry(registry);
    const introspect = vi.fn(async () => ({ active: false }));
    vi.mocked(fetch).mockClear();
    const flight = registry.begin({
      principalKey: "https://idp.example/realms/agents|human-1|agent-client",
      humanKey: "https://idp.example/realms/agents|human-1",
      tenant: "tenant-a",
    });
    await expect(runWithIdentity(identity, () => drupalFetch(
      { _name: "t", baseUrl: "https://x" },
      "/jsonapi/node/article",
      { method: "POST", body: "{}" },
    ), { surface: "network", bearer: "tok-live", introspect, identity })).rejects.toThrow(GENERIC_PRINCIPAL_REFUSAL);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(flight.signal.aborted).toBe(true);
  });

  it("does not re-introspect a JSON:API GET", async () => {
    const introspect = vi.fn(async () => ({ active: false }));
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });
    await runWithIdentity(identity, () => drupalFetch(
      { _name: "t", baseUrl: "https://x" },
      "/jsonapi/node/article",
    ), { surface: "network", bearer: "tok-live", introspect });
    expect(introspect).not.toHaveBeenCalled();
  });

  it("denies when introspection throws, with no identity leakage", async () => {
    const introspect = vi.fn(async () => {
      throw new Error("issuer timeout for human-1");
    });
    try {
      await runWithIdentity(identity, () => assertLiveTokenForGovernedWrite({
        bearer: "tok-live",
        introspect,
        identity,
      }), { surface: "network", bearer: "tok-live", introspect });
      throw new Error("throwing introspector must deny");
    } catch (err) {
      expect(err).toBeInstanceOf(SecurityError);
      expect(err.message).toBe(GENERIC_PRINCIPAL_REFUSAL);
      expect(err.message).not.toMatch(/human-1|timeout|tok-live/);
    }
  });

  it("denies when introspection times out (AbortError)", async () => {
    const introspect = vi.fn(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    await expect(runWithIdentity(identity, () => assertLiveTokenForGovernedWrite({
      bearer: "tok-live",
      introspect,
      identity,
    }), { surface: "network", bearer: "tok-live", introspect })).rejects.toThrow(GENERIC_PRINCIPAL_REFUSAL);
  });

  it("lets a throwing introspector through when the guard is removed (red evidence)", async () => {
    setWriteReintrospectGuard(false);
    const introspect = vi.fn(async () => {
      throw new Error("issuer down");
    });
    await expect(assertLiveTokenForGovernedWrite({
      bearer: "tok-live",
      introspect,
      identity,
    })).resolves.toBeUndefined();
    expect(introspect).not.toHaveBeenCalled();
  });

  it("denies a network-origin write with no bearer", async () => {
    await expect(runWithIdentity(identity, () => assertLiveTokenForGovernedWrite({
      identity,
    }), { surface: "network" })).rejects.toThrow(GENERIC_PRINCIPAL_REFUSAL);
  });

  it("admits a network write with no bearer when the guard is removed (red evidence)", async () => {
    setWriteReintrospectGuard(false);
    await expect(runWithIdentity(identity, () => assertLiveTokenForGovernedWrite({
      identity,
    }), { surface: "network" })).resolves.toBeUndefined();
  });

  it("skips a missing bearer on stdio", async () => {
    await expect(assertLiveTokenForGovernedWrite({ identity })).resolves.toBeUndefined();
  });

  it("skips a second check when the relay edge stamped tokenLive", async () => {
    const introspect = vi.fn(async () => ({ active: false, killed: true }));
    await runWithIdentity(identity, () => assertLiveTokenForGovernedWrite({
      identity,
      introspect,
    }), { surface: "network", tokenLive: true, introspect });
    expect(introspect).not.toHaveBeenCalled();
  });
});
