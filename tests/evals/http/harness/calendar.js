/**
 * Strict `YYYY-MM-DD` calendar check for known-red expiry dates. A regex
 * alone accepts `2026-99-99`, which compares as a future string and would
 * keep a known-red entry alive forever; the value must round-trip through
 * UTC to the same day.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCalendarDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day);
  return Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === value;
}
