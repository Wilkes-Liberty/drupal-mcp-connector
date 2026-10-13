import { describe, it, expect } from "vitest";
import {
  createHttpRateLimiters,
  createRateLimiter,
  DEFAULT_HTTPS_RATE_LIMIT,
  DEFAULT_RATE_MAX_KEYS,
  DEFAULT_RATE_WINDOW_SEC,
  rateLimitAddressKey,
  rateLimitPrincipalKey,
  resolveHttpRateLimitOptions,
} from "../../src/lib/rate-limit.js";

describe("createRateLimiter", () => {
  it("allows requests up to the limit, then denies within the window", () => {
    let t = 1000;
    const rl = createRateLimiter({ limit: 3, windowMs: 10_000, now: () => t });
    expect(rl.check("a").allowed).toBe(true);   // 1
    expect(rl.check("a").allowed).toBe(true);   // 2
    const third = rl.check("a");                 // 3 (at limit)
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    const fourth = rl.check("a");                // 4 (over)
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBe(10);
  });

  it("tracks keys independently", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("b").allowed).toBe(true);   // different key, own bucket
    expect(rl.check("a").allowed).toBe(false);  // a exhausted
  });

  it("resets after the window elapses", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
    t = 1000;                                    // window rolled over
    expect(rl.check("a").allowed).toBe(true);
  });

  it("is disabled (always allows) when limit is falsy or <= 0", () => {
    for (const limit of [0, -5, undefined, null]) {
      const rl = createRateLimiter({ limit, windowMs: 1000 });
      const v = rl.check("a");
      expect(v.allowed).toBe(true);
      expect(v.remaining).toBe(Infinity);
    }
  });

  it("prunes expired buckets so the map does not grow unbounded", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t, maxKeys: 2 });
    rl.check("a"); rl.check("b");
    t = 2000;                                    // a and b expired
    rl.check("c");                               // triggers prune of expired entries
    expect(rl.size()).toBeLessThanOrEqual(2);
  });

  it("hard-caps tracked keys when many distinct principals or addresses are sprayed", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0, maxKeys: 8 });
    for (let i = 0; i < 200; i += 1) {
      rl.check(`spray-${i}`);
    }
    expect(rl.size()).toBeLessThanOrEqual(8);
  });

  it("never evicts a live bucket under key spray; a denied key stays denied", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0, maxKeys: 4 });
    expect(rl.check("victim").allowed).toBe(true);
    expect(rl.check("victim").allowed).toBe(false);
    for (let i = 0; i < 50; i += 1) rl.check(`spray-${i}`);
    expect(rl.size()).toBeLessThanOrEqual(4);
    // The exhausted bucket survived the spray.
    expect(rl.check("victim").allowed).toBe(false);
    expect(rl.peek("victim").allowed).toBe(false);
    // Keys admitted while the map is full share one fail-closed bucket, so
    // the spray itself is throttled instead of being granted fresh quota.
    expect(rl.check("spray-new").allowed).toBe(false);
    expect(rl.peek("spray-unseen").allowed).toBe(false);
  });

  it("peek reports exhaustion without consuming a slot", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    expect(rl.peek("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.peek("a").allowed).toBe(false);
    expect(rl.peek("a").retryAfterSec).toBe(1);
    expect(rl.check("b").allowed).toBe(true);
  });
});

describe("rate-limit keys", () => {
  it("builds a principal key from verified sub+clientId and never from headers", () => {
    expect(rateLimitPrincipalKey({ sub: "alice", clientId: "client-a" })).toBe('principal:["alice","client-a"]');
    // A NUL inside a claim must not fold two principals into one bucket.
    expect(rateLimitPrincipalKey({ sub: "a\0b", clientId: "c" }))
      .not.toBe(rateLimitPrincipalKey({ sub: "a", clientId: "b\0c" }));
    expect(rateLimitPrincipalKey({ sub: "a", clientId: "" }))
      .not.toBe(rateLimitPrincipalKey({ sub: "", clientId: "a" }));
    expect(rateLimitPrincipalKey({ localOperator: true, sub: "ignored" })).toBe("principal:local-operator");
    expect(rateLimitPrincipalKey(null)).toBeNull();
    expect(rateLimitPrincipalKey({ sub: "", clientId: "" })).toBeNull();
    expect(rateLimitAddressKey("203.0.113.9")).toBe("addr:203.0.113.9");
  });
});

describe("resolveHttpRateLimitOptions", () => {
  it("defaults to 120/60s on non-loopback TLS and off on loopback", () => {
    expect(resolveHttpRateLimitOptions({ hasTls: true, loopbackBind: false, env: {} })).toEqual({
      addressLimit: DEFAULT_HTTPS_RATE_LIMIT,
      principalLimit: DEFAULT_HTTPS_RATE_LIMIT,
      windowSec: DEFAULT_RATE_WINDOW_SEC,
      windowMs: DEFAULT_RATE_WINDOW_SEC * 1000,
      maxKeys: DEFAULT_RATE_MAX_KEYS,
    });
    expect(resolveHttpRateLimitOptions({ hasTls: true, loopbackBind: true, env: {} }).addressLimit).toBe(0);
  });

  it("lets MCP_RATE_LIMIT set both gates and MCP_PRINCIPAL_RATE_LIMIT override the principal gate", () => {
    const both = resolveHttpRateLimitOptions({
      hasTls: true,
      loopbackBind: false,
      env: { MCP_RATE_LIMIT: "50", MCP_RATE_WINDOW_SEC: "30", MCP_RATE_MAX_KEYS: "100" },
    });
    expect(both.addressLimit).toBe(50);
    expect(both.principalLimit).toBe(50);
    expect(both.windowSec).toBe(30);
    expect(both.maxKeys).toBe(100);

    const split = resolveHttpRateLimitOptions({
      hasTls: true,
      loopbackBind: false,
      env: { MCP_RATE_LIMIT: "50", MCP_PRINCIPAL_RATE_LIMIT: "10" },
    });
    expect(split.addressLimit).toBe(50);
    expect(split.principalLimit).toBe(10);

    const off = resolveHttpRateLimitOptions({
      hasTls: true,
      loopbackBind: false,
      env: { MCP_RATE_LIMIT: "0" },
    });
    expect(off.addressLimit).toBe(0);
    expect(off.principalLimit).toBe(0);
  });

  it("keeps address and principal limiters isolated even when the limits are equal", () => {
    const { rateLimiter, principalLimiter } = createHttpRateLimiters({
      addressLimit: 5,
      principalLimit: 5,
      windowMs: 1000,
      maxKeys: 10,
      now: () => 0,
    });
    expect(rateLimiter).not.toBeNull();
    expect(principalLimiter).not.toBeNull();
    expect(rateLimiter).not.toBe(principalLimiter);
    // An address spray fills the address map but cannot touch principal quota.
    for (let i = 0; i < 100; i += 1) rateLimiter.check(`addr:198.51.100.${i}`);
    expect(principalLimiter.size()).toBe(0);
    expect(principalLimiter.check("principal:[\"alice\",\"c\"]").allowed).toBe(true);
  });
});

