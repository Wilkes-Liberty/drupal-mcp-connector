import { describe, it, expect } from "vitest";
import { createRateLimiter } from "../../src/lib/rate-limit.js";

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
});
