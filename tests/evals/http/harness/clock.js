/**
 * Fake clock. jose reads `Date`, so faking `Date` alone moves token expiry
 * without sleeps. Timers stay real.
 */

import { vi } from "vitest";

/** Fixed start instant for every case (synthetic). */
export const FIXTURE_NOW = new Date("2026-10-10T16:00:00.000Z");

/**
 * Install the fake `Date`. Call `restore()` in teardown.
 * @returns {{now: () => number, advance: (ms: number) => void, restore: () => void}}
 */
export function installFakeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXTURE_NOW);
  return {
    now: () => Date.now(),
    advance: (ms) => vi.setSystemTime(Date.now() + ms),
    restore: () => vi.useRealTimers(),
  };
}
