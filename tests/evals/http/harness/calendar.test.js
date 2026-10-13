import { describe, expect, it } from "vitest";
import { isCalendarDay } from "./calendar.js";

describe("isCalendarDay (known-red expiry)", () => {
  it("accepts only real UTC calendar days in YYYY-MM-DD form", () => {
    expect(isCalendarDay("2026-10-13")).toBe(true);
    expect(isCalendarDay("2024-02-29")).toBe(true);
    for (const bad of ["2026-99-99", "2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-1-1", "2026-10-13T00:00:00Z", "", null, 20261013]) {
      expect(isCalendarDay(bad), String(bad)).toBe(false);
    }
  });
});
