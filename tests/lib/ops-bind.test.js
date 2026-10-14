/**
 * DEV-863: ops listener bind rules. Public / wildcard / non-mesh addresses
 * and port 0 are fatal. Red evidence uses a test-only fixture, not a
 * production toggle.
 */
import { describe, expect, it } from "vitest";
import {
  isOpsBindAllowed,
  OPS_LISTEN_PARSE_REASON,
  opsBindRefusedReason,
  parseOpsListen,
  resolveOpsListen,
} from "../../src/lib/ops-bind.js";
import { startOpsListener } from "../../src/lib/ops-listener.js";
import { createOpsMetrics } from "../../src/lib/ops-metrics.js";

const PUBLIC_HOSTS = Object.freeze([
  "0.0.0.0",
  "::",
  "8.8.8.8",
  "1.1.1.1",
  "192.0.2.10",
  "10.0.0.1",
  "192.168.1.1",
  "172.16.0.1",
  "100.63.255.255",
  "100.128.0.1",
  "2001:db8::1",
  "example.com",
  "*",
  "::ffff:0.0.0.0",
  "::ffff:8.8.8.8",
  "::ffff:192.0.2.10",
]);

/**
 * Shared refusal assertion. A fixture that admits public binds makes this throw.
 *
 * @param {(host: string) => boolean} allowed
 */
function assertPublicBindsRefused(allowed = isOpsBindAllowed) {
  for (const host of PUBLIC_HOSTS) {
    expect({ host, allowed: allowed(host) }).toEqual({ host, allowed: false });
  }
}

describe("parseOpsListen", () => {
  it("treats unset or empty as disabled", () => {
    expect(parseOpsListen(undefined)).toEqual({ enabled: false });
    expect(parseOpsListen("")).toEqual({ enabled: false });
    expect(parseOpsListen("   ")).toEqual({ enabled: false });
  });

  it("parses IPv4, localhost, and bracketed IPv6", () => {
    expect(parseOpsListen("127.0.0.1:9090")).toEqual({ enabled: true, host: "127.0.0.1", port: 9090 });
    expect(parseOpsListen("localhost:9090")).toEqual({ enabled: true, host: "localhost", port: 9090 });
    expect(parseOpsListen("[::1]:9090")).toEqual({ enabled: true, host: "::1", port: 9090 });
    expect(parseOpsListen("[fd7a:115c:a1e0::1]:9100")).toEqual({
      enabled: true,
      host: "fd7a:115c:a1e0::1",
      port: 9100,
    });
  });

  it("is fatal for a present but unparseable spec or port 0", () => {
    expect(parseOpsListen("not-a-listen")).toEqual({ enabled: false, error: OPS_LISTEN_PARSE_REASON });
    expect(parseOpsListen(":9090")).toEqual({ enabled: false, error: OPS_LISTEN_PARSE_REASON });
    expect(parseOpsListen("127.0.0.1:99999")).toEqual({ enabled: false, error: OPS_LISTEN_PARSE_REASON });
    expect(parseOpsListen("127.0.0.1:0")).toEqual({ enabled: false, error: OPS_LISTEN_PARSE_REASON });
    expect(parseOpsListen("localhost:0")).toEqual({ enabled: false, error: OPS_LISTEN_PARSE_REASON });
    expect(resolveOpsListen({ env: { MCP_OPS_LISTEN: "127.0.0.1:0" } })).toEqual({
      enabled: false,
      fatal: true,
      reason: OPS_LISTEN_PARSE_REASON,
    });
  });
});

describe("public-bind refusal (DEV-863)", () => {
  it("allows loopback and Tailscale literals only", () => {
    expect(isOpsBindAllowed("127.0.0.1")).toBe(true);
    expect(isOpsBindAllowed("127.0.0.2")).toBe(true);
    expect(isOpsBindAllowed("::1")).toBe(true);
    expect(isOpsBindAllowed("localhost")).toBe(true);
    expect(isOpsBindAllowed("100.64.0.1")).toBe(true);
    expect(isOpsBindAllowed("100.127.255.255")).toBe(true);
    expect(isOpsBindAllowed("fd7a:115c:a1e0::1")).toBe(true);
    expect(isOpsBindAllowed("fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff")).toBe(true);
  });

  it("refuses 0.0.0.0, ::, public, and other non-mesh addresses", () => {
    assertPublicBindsRefused();
  });

  it("folds ::ffff: mapped binds to the underlying IPv4 decision", () => {
    expect(isOpsBindAllowed("::ffff:127.0.0.1")).toBe(true);
    expect(isOpsBindAllowed("::ffff:100.64.0.1")).toBe(true);
    expect(isOpsBindAllowed("::ffff:0.0.0.0")).toBe(false);
    expect(isOpsBindAllowed("::ffff:8.8.8.8")).toBe(false);
    expect(resolveOpsListen({ env: { MCP_OPS_LISTEN: "[::ffff:8.8.8.8]:9090" } }).fatal).toBe(true);
    expect(resolveOpsListen({ env: { MCP_OPS_LISTEN: "[::ffff:127.0.0.1]:9090" } })).toEqual({
      enabled: true,
      host: "::ffff:127.0.0.1",
      port: 9090,
    });
  });

  it("resolveOpsListen is fatal for a public bind and does not enable the listener", () => {
    const resolved = resolveOpsListen({ env: { MCP_OPS_LISTEN: "0.0.0.0:9090" } });
    expect(resolved).toEqual({
      enabled: false,
      fatal: true,
      reason: opsBindRefusedReason("0.0.0.0"),
    });
  });

  it("startOpsListener exits before listen on 0.0.0.0", async () => {
    const exits = [];
    const result = await startOpsListener({
      resolved: { enabled: true, host: "0.0.0.0", port: 9090 },
      metrics: createOpsMetrics(),
      exit: (code, reason) => { exits.push({ code, reason }); },
      log: () => {},
    });
    expect(result.started).toBe(false);
    expect(result.server).toBeUndefined();
    expect(exits).toEqual([{ code: 1, reason: opsBindRefusedReason("0.0.0.0") }]);
  });

  it("fails when a test-only fixture admits public binds (red evidence)", () => {
    expect(() => assertPublicBindsRefused(() => true)).toThrow(/allowed/);
  });
});
