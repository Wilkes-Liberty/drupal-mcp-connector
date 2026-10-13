/**
 * Pinned assertion labels (a-2 / c-1). A mutant kill or a known-red entry
 * names the assertion that must fail. Matching is on the complete label,
 * never a substring or a prefix: vitest formats a labelled failure as
 * `<label>: expected …`, so the first line must be the label itself or the
 * label followed by the `: expected` tail. Labels themselves contain `:`
 * (`GET /health: status`), which is why a bare `:` boundary is not enough.
 * A blank or whitespace-only pin matches nothing.
 */

/**
 * First line of an assertion message: the label, or the label plus the
 * `expected … to …` tail vitest appends.
 *
 * @param {unknown} reason
 * @returns {string}
 */
export function assertionLabel(reason) {
  return String(reason || "").split("\n")[0];
}

/**
 * @param {unknown} expected
 * @returns {boolean}
 */
export function isPinnedLabel(expected) {
  return typeof expected === "string" && expected.trim().length > 0;
}

/**
 * @param {unknown} actual   Assertion error message.
 * @param {unknown} expected Pinned label.
 * @returns {boolean}
 */
export function labelMatches(actual, expected) {
  if (!isPinnedLabel(expected)) return false;
  const line = assertionLabel(actual);
  const label = expected.trim();
  return line === label || line.startsWith(`${label}: expected `);
}
