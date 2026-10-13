import { describe, expect, it } from "vitest";
import {
  isTrustedProxy,
  normalizeIp,
  parseForwardedFor,
  parseTrustedProxies,
  resolveClientAddress,
  resolveTrustedProxies,
  socketAddress,
} from "../../src/lib/client-address.js";

function req(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

describe("normalizeIp", () => {
  it("strips IPv4-mapped prefixes, ports, brackets, and zone ids", () => {
    expect(normalizeIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    // Hex is case-insensitive: the same endpoint must always get one key.
    expect(normalizeIp("::FFFF:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIp("[::FfFf:203.0.113.9]:8443")).toBe("203.0.113.9");
    expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1");
    expect(normalizeIp("2001:DB8::1")).toBe(normalizeIp("2001:db8::1"));
    // Equivalent IPv6 spellings canonicalize to one RFC 5952 form.
    expect(normalizeIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(normalizeIp("2001:0db8:0:0:0:0:0:1")).toBe(normalizeIp("2001:db8::1"));
    expect(normalizeIp("0:0:0:0:0:0:0:1")).toBe("::1");
    expect(normalizeIp("[2001:DB8:0:0::1]:8443")).toBe("2001:db8::1");
    // An IPv4-mapped address spelled in hex folds to the same IPv4 key.
    expect(normalizeIp("::ffff:cb00:7109")).toBe("203.0.113.9");
    expect(normalizeIp("::FFFF:CB00:7109")).toBe(normalizeIp("::ffff:203.0.113.9"));
    expect(normalizeIp("203.0.113.9:8443")).toBe("203.0.113.9");
    expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });

  it("returns empty for non-IP tokens", () => {
    expect(normalizeIp("unknown")).toBe("");
    expect(normalizeIp("not-an-ip")).toBe("");
    expect(normalizeIp("")).toBe("");
    expect(normalizeIp(null)).toBe("");
  });
});

describe("parseTrustedProxies / resolveTrustedProxies", () => {
  it("defaults to trust none", () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies("")).toEqual([]);
    expect(resolveTrustedProxies({ env: {} })).toEqual([]);
  });

  it("parses CIDR and single IPs from arrays or comma strings", () => {
    expect(parseTrustedProxies(["10.0.0.1", "10.1.0.0/16"])).toEqual(["10.0.0.1", "10.1.0.0/16"]);
    expect(parseTrustedProxies("10.0.0.1, 10.1.0.0/16")).toEqual(["10.0.0.1", "10.1.0.0/16"]);
  });

  it("skips invalid specs so a typo cannot widen trust", () => {
    expect(parseTrustedProxies(["10.0.0.1", "not-a-proxy", "10.0.0.0/99", "10.0.0.0/", "2001:db8::/"])).toEqual(["10.0.0.1"]);
  });

  it("accepts only a decimal prefix length, never empty, hex, exponent, or signed forms", () => {
    // Number("") is 0 and Number("0x0") / Number("0e0") are integers: each
    // would reach BlockList as /0 and trust every peer.
    for (const bad of ["10.0.0.0/", "10.0.0.0/0x0", "10.0.0.0/0e0", "10.0.0.0/1e1", "10.0.0.0/+8", "10.0.0.0/-0", "10.0.0.0/ 8", "10.0.0.0/8.0", "2001:db8::/0x40"]) {
      expect(parseTrustedProxies([bad]), bad).toEqual([]);
      expect(isTrustedProxy("8.8.8.8", [bad]), bad).toBe(false);
      expect(isTrustedProxy("2001:db8::1", [bad]), bad).toBe(false);
    }
    expect(parseTrustedProxies(["10.0.0.0/0", "10.0.0.0/08", "2001:db8::/64"])).toEqual(["10.0.0.0/0", "10.0.0.0/08", "2001:db8::/64"]);
    expect(isTrustedProxy("8.8.8.8", ["10.0.0.0/0"])).toBe(true);
    expect(isTrustedProxy("10.3.0.1", ["10.0.0.0/08"])).toBe(true);
  });

  it("lets MCP_TRUSTED_PROXIES replace the configured list, including empty", () => {
    expect(resolveTrustedProxies({
      trustedProxies: ["10.0.0.1"],
      env: { MCP_TRUSTED_PROXIES: "192.0.2.1, 198.51.100.0/24" },
    })).toEqual(["192.0.2.1", "198.51.100.0/24"]);
    expect(resolveTrustedProxies({
      trustedProxies: ["10.0.0.1"],
      env: { MCP_TRUSTED_PROXIES: "" },
    })).toEqual([]);
  });
});

describe("isTrustedProxy", () => {
  it("matches exact IPs and CIDR ranges", () => {
    expect(isTrustedProxy("10.0.0.1", ["10.0.0.1"])).toBe(true);
    expect(isTrustedProxy("10.1.2.3", ["10.1.0.0/16"])).toBe(true);
    expect(isTrustedProxy("192.0.2.1", ["10.0.0.0/8"])).toBe(false);
    expect(isTrustedProxy("203.0.113.9", [])).toBe(false);
  });
});

describe("resolveClientAddress", () => {
  it("uses the socket address when no proxies are trusted (default)", () => {
    const request = req("203.0.113.9", { "x-forwarded-for": "198.51.100.7" });
    expect(resolveClientAddress(request, [])).toBe("203.0.113.9");
    expect(socketAddress(request)).toBe("203.0.113.9");
  });

  it("ignores a spoofed X-Forwarded-For from an untrusted peer", () => {
    expect(resolveClientAddress(
      req("203.0.113.9", { "x-forwarded-for": "198.51.100.7" }),
      ["10.0.0.1"],
    )).toBe("203.0.113.9");
  });

  it("uses X-Forwarded-For when the immediate peer is a trusted proxy", () => {
    expect(resolveClientAddress(
      req("10.0.0.1", { "x-forwarded-for": "198.51.100.7" }),
      ["10.0.0.1"],
    )).toBe("198.51.100.7");
  });

  it("walks the X-Forwarded-For chain from the right and skips trusted hops", () => {
    // client, spoofed-or-prior, last-trusted-seen-client appended by proxy
    expect(resolveClientAddress(
      req("10.0.0.1", { "x-forwarded-for": "8.8.8.8, 198.51.100.7" }),
      ["10.0.0.1", "10.0.0.0/8"],
    )).toBe("198.51.100.7");
  });

  it("falls back to the socket when a trusted peer sends no usable X-Forwarded-For", () => {
    expect(resolveClientAddress(req("10.0.0.1", {}), ["10.0.0.1"])).toBe("10.0.0.1");
    expect(resolveClientAddress(
      req("10.0.0.1", { "x-forwarded-for": "unknown" }),
      ["10.0.0.1"],
    )).toBe("10.0.0.1");
  });

  it("parses multi-value headers and drops non-IP tokens", () => {
    expect(parseForwardedFor(["unknown", "198.51.100.7, 10.0.0.1"])).toEqual([
      "198.51.100.7",
      "10.0.0.1",
    ]);
  });
});
