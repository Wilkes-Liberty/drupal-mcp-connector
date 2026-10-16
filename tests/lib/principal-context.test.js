/**
 * Frozen Paladin principal + tenant (DEV-839). Deny tests include a red
 * run with the guard removed so they can fail.
 */

import { afterEach, describe, expect, it } from "vitest";
import { buildIdentity } from "../../src/lib/http-auth.js";
import {
  GENERIC_PRINCIPAL_REFUSAL,
  PRINCIPAL_CONTEXT_GUARD,
  RESERVED_PRINCIPAL_ARG_KEYS,
  SPOOFABLE_TENANT_HEADERS,
  assertFrozenPrincipal,
  freezePrincipalContext,
  setPrincipalContextGuard,
  tenantFromClaims,
} from "../../src/lib/principal-context.js";
import { runWithIdentity } from "../../src/lib/principal.js";
import { SecurityError } from "../../src/lib/security.js";
import { callTool } from "../../src/lib/dispatch.js";

const claims = {
  iss: "https://idp.example/realms/agents",
  sub: "human-1",
  azp: "agent-client",
  tenant: "tenant-a",
  scope: "mcp_read mcp_write",
};

const identity = (over = {}) => ({
  ...buildIdentity({ ...claims, ...over }),
  ...over,
});

describe("freezePrincipalContext", () => {
  it("documents spoofable tenant fields that never become authority", () => {
    expect(RESERVED_PRINCIPAL_ARG_KEYS).toEqual(expect.arrayContaining(["tenant", "tenant_id", "tenantId"]));
    expect(SPOOFABLE_TENANT_HEADERS).toEqual(expect.arrayContaining([
      "x-mcp-tenant", "x-forwarded-tenant",
    ]));
  });

  it("copies verified Paladin fields and does not invent azp from client_id", () => {
    const ctx = freezePrincipalContext({
      iss: claims.iss,
      sub: claims.sub,
      client_id: "must-not-be-actor",
      tenant: "tenant-a",
    }, { network: true });
    expect(ctx.tenant).toBe("tenant-a");
    expect(ctx.azp).toBe("");
    expect(ctx.keyClaims).not.toHaveProperty("client_id");
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("takes tenant only from the string tenant claim", () => {
    expect(tenantFromClaims({ tenant: "tenant-a" })).toBe("tenant-a");
    expect(tenantFromClaims({ tenant: 1 })).toBe("");
    expect(tenantFromClaims({ tenant_id: "tenant-a" })).toBe("");
    expect(tenantFromClaims({ mcp_tenant: "tenant-a" })).toBe("");
    expect(buildIdentity({ ...claims, tenant: 99 }).tenant).toBeNull();
  });

  it("does not widen an integer sub into a principal key claim", () => {
    const frozen = buildIdentity({ ...claims, sub: 1 });
    expect(frozen.keyClaims.sub).toBe(1);
  });
});

describe("DEV-839 tenant claim (network)", () => {
  afterEach(() => {
    setPrincipalContextGuard(true);
  });

  it("refuses a network call whose token omits tenant", () => {
    const who = identity({ tenant: null, keyClaims: { iss: claims.iss, sub: claims.sub, azp: claims.azp } });
    expect(() => assertFrozenPrincipal({
      identity: who,
      surface: "network",
      args: { tenant: "tenant-from-args" },
      headers: { "x-mcp-tenant": "tenant-from-header" },
    })).toThrow(SecurityError);
    expect(() => assertFrozenPrincipal({
      identity: who,
      surface: "network",
      args: { tenant: "tenant-from-args" },
    })).toThrow(GENERIC_PRINCIPAL_REFUSAL);
  });

  it("ignores args and headers when the Paladin tenant claim is present", () => {
    const who = identity();
    const ctx = assertFrozenPrincipal({
      identity: who,
      surface: "network",
      args: { tenant: "forged-tenant", site: "production" },
      headers: { "x-mcp-tenant": "forged-header" },
    });
    expect(ctx.tenant).toBe("tenant-a");
    expect(ctx.tenant).not.toBe("forged-tenant");
  });

  it("admits a missing tenant when the guard is removed (red evidence)", () => {
    setPrincipalContextGuard(false);
    expect(PRINCIPAL_CONTEXT_GUARD.required).toBe(false);
    const who = identity({ tenant: null, keyClaims: { iss: claims.iss, sub: claims.sub, azp: claims.azp } });
    const ctx = assertFrozenPrincipal({ identity: who, surface: "network", args: {} });
    expect(ctx.tenant).toBe("");
  });

  it("rejects a principalContext that does not match identity", () => {
    const who = identity();
    expect(() => assertFrozenPrincipal({
      identity: who,
      surface: "network",
      principalContext: freezePrincipalContext({
        ...claims,
        tenant: "forged-tenant",
      }, { network: true }),
    })).toThrow(GENERIC_PRINCIPAL_REFUSAL);
  });

  it("returns a generic deny from tools/call with no identity leakage", async () => {
    const who = identity({ tenant: null, keyClaims: { iss: claims.iss, sub: claims.sub, azp: claims.azp } });
    const result = await runWithIdentity(
      who,
      () => callTool("drupal_get_node", { site: "production", tenant: "tenant-from-args" }, {
        identity: who,
        sites: [{ _name: "production", baseUrl: "https://drupal.example.com", security: { preset: "development" } }],
        grants: { "agent-client": ["production"] },
      }),
      { surface: "network" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`Access denied: ${GENERIC_PRINCIPAL_REFUSAL}`);
    expect(result.content[0].text).not.toMatch(/human-1|tenant-a|tenant-from-args|agent-client/);
  });
});
