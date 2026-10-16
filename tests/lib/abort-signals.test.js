import { describe, expect, it } from "vitest";
import { combineAbortSignals } from "../../src/lib/abort-signals.js";

describe("combineAbortSignals", () => {
  it("returns the timeout when it is the only signal", () => {
    const timeout = AbortSignal.timeout(30_000);
    expect(combineAbortSignals(timeout, null)).toBe(timeout);
  });

  it("keeps the timeout when AbortSignal.any is missing", async () => {
    const original = AbortSignal.any;
    AbortSignal.any = undefined;
    try {
      const timeout = AbortSignal.timeout(20);
      const parent = new AbortController();
      const combined = combineAbortSignals(timeout, parent.signal);
      expect(combined).toBeDefined();
      expect(combined.aborted).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(combined.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);
      expect(combined.reason?.name).toBe("TimeoutError");
    } finally {
      AbortSignal.any = original;
    }
  });

  it("forwards a parent abort when AbortSignal.any is missing", () => {
    const original = AbortSignal.any;
    AbortSignal.any = undefined;
    try {
      const timeout = AbortSignal.timeout(30_000);
      const parent = new AbortController();
      const combined = combineAbortSignals(timeout, parent.signal);
      parent.abort("cancelled");
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe("cancelled");
      expect(timeout.aborted).toBe(false);
    } finally {
      AbortSignal.any = original;
    }
  });
});
