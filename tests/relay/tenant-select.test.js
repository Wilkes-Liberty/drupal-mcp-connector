/**
 * Tenant-session selection (#242 / DEV-122) — pure fail-closed rules.
 *
 * No sockets. Hello admission and fan-down selection are the isolation
 * primitive: tunnel identity is the tenant boundary.
 */

import { describe, expect, it } from "vitest";
import {
  acceptAgentHello,
  boundSiteNames,
  selectTenantSession,
  siteBindingKey,
} from "../../src/lib/relay/edge.js";

const CATALOG = ["tenant-alpha", "tenant-beta"];

describe("boundSiteNames", () => {
  it("treats missing or commented entries as unscoped", () => {
    expect(boundSiteNames(null)).toEqual([]);
    expect(boundSiteNames(undefined)).toEqual([]);
    expect(boundSiteNames(["tenant-alpha", "_comment", ""])).toEqual(["tenant-alpha"]);
    expect(siteBindingKey(null)).toBe(siteBindingKey([]));
    expect(siteBindingKey(["tenant-beta", "tenant-alpha"]))
      .toBe(siteBindingKey(["tenant-alpha", "tenant-beta"]));
  });
});

describe("acceptAgentHello", () => {
  it("denies a missing or revoked channel record", () => {
    expect(acceptAgentHello({ record: null })).toEqual({
      ok: false, reason: "unauthenticated",
    });
    expect(acceptAgentHello({
      record: { agentId: "tenant-a", revoked: true },
    })).toEqual({ ok: false, reason: "revoked" });
  });

  it("accepts the first agent unscoped (DEV-294 compatibility)", () => {
    expect(acceptAgentHello({
      record: { agentId: "tenant-a" },
      catalogNames: CATALOG,
    })).toEqual({ ok: true, sites: null });
  });

  it("denies a second unscoped agent and a scoped agent joining an unscoped one", () => {
    const unscoped = [{ agentId: "tenant-a", sites: null }];
    expect(acceptAgentHello({
      record: { agentId: "tenant-b" },
      sessions: unscoped,
      catalogNames: CATALOG,
    })).toEqual({ ok: false, reason: "unbound_tenant" });
    expect(acceptAgentHello({
      record: { agentId: "tenant-b", sites: ["tenant-beta"] },
      sessions: unscoped,
      catalogNames: CATALOG,
    })).toEqual({ ok: false, reason: "unbound_tenant" });
  });

  it("accepts a second agent bound to a disjoint site and denies overlap", () => {
    const first = [{ agentId: "tenant-a", sites: ["tenant-alpha"] }];
    expect(acceptAgentHello({
      record: { agentId: "tenant-b", sites: ["tenant-beta"] },
      sessions: first,
      catalogNames: CATALOG,
    })).toEqual({ ok: true, sites: ["tenant-beta"] });
    expect(acceptAgentHello({
      record: { agentId: "tenant-b", sites: ["tenant-alpha"] },
      sessions: first,
      catalogNames: CATALOG,
    })).toEqual({ ok: false, reason: "overlapping_tenant" });
  });

  it("drops unknown catalog names and refuses a bind that matches none", () => {
    expect(acceptAgentHello({
      record: { agentId: "tenant-a", sites: ["tenant-alpha", "not-a-site"] },
      catalogNames: CATALOG,
    })).toEqual({ ok: true, sites: ["tenant-alpha"] });
    expect(acceptAgentHello({
      record: { agentId: "tenant-a", sites: ["not-a-site"] },
      catalogNames: CATALOG,
    })).toEqual({ ok: false, reason: "unbound_tenant" });
  });

  it("allows reconnect of the same agentId even when another tenant is connected", () => {
    expect(acceptAgentHello({
      record: { agentId: "tenant-a", sites: ["tenant-alpha"] },
      sessions: [
        { agentId: "tenant-a", sites: ["tenant-alpha"] },
        { agentId: "tenant-b", sites: ["tenant-beta"] },
      ],
      catalogNames: CATALOG,
    })).toEqual({ ok: true, sites: ["tenant-alpha"] });
  });
});

describe("selectTenantSession", () => {
  const a = { agentId: "tenant-a", sites: ["tenant-alpha"] };
  const b = { agentId: "tenant-b", sites: ["tenant-beta"] };

  it("denies an unentitled principal before looking at agents", () => {
    expect(selectTenantSession({
      grantedSiteNames: [],
      sessions: [a, b],
    })).toEqual({ session: null, reason: "not_entitled" });
    expect(selectTenantSession({
      grantedSiteNames: ["tenant-alpha"],
      targetName: "tenant-beta",
      sessions: [a, b],
    })).toEqual({ session: null, reason: "not_entitled" });
  });

  it("routes each principal to its bound tenant and no_agent when that tunnel is down", () => {
    expect(selectTenantSession({
      grantedSiteNames: ["tenant-alpha"],
      sessions: [a, b],
    }).session).toBe(a);
    expect(selectTenantSession({
      grantedSiteNames: ["tenant-beta"],
      targetName: "tenant-beta",
      sessions: [a, b],
    }).session).toBe(b);
    expect(selectTenantSession({
      grantedSiteNames: ["tenant-alpha"],
      sessions: [b],
    })).toEqual({ session: null, reason: "no_agent" });
  });

  it("keeps a single unscoped agent as the compatibility path", () => {
    const unscoped = { agentId: "tenant-a", sites: null };
    expect(selectTenantSession({
      grantedSiteNames: ["tenant-alpha"],
      sessions: [unscoped],
    }).session).toBe(unscoped);
  });

  it("fails closed when grants span two tunnels", () => {
    expect(selectTenantSession({
      grantedSiteNames: ["tenant-alpha", "tenant-beta"],
      sessions: [a, b],
    })).toEqual({ session: null, reason: "not_entitled" });
  });
});
