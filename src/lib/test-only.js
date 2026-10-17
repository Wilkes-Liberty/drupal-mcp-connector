/**
 * Test-only seams. Production callers must not flip guards.
 */

/**
 * Throw unless this process is a test runner.
 *
 * @param {string} name Guard setter name, for the error.
 * @returns {void}
 * @throws {Error}
 */
export function assertTestOnly(name) {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") return;
  throw new Error(`${name} is test-only.`);
}
