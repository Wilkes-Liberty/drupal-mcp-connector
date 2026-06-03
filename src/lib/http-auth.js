/**
 * Optional bearer-token authentication for the HTTPS MCP transport.
 * makeBearerCheck(token) returns a predicate over the Authorization header.
 * A falsy token disables auth (predicate always true) — opt-in by design.
 */

import { timingSafeEqual } from "crypto";

/**
 * Build a predicate that validates an HTTP Authorization header against an
 * expected bearer token.
 * @param {?string} token Expected token; falsy disables auth (predicate is always true).
 * @returns {(authorizationHeader: any) => boolean} True when the header carries the token.
 */
export function makeBearerCheck(token) {
  if (!token) return () => true; // auth disabled
  const expected = Buffer.from(String(token));
  return (authorizationHeader) => {
    if (typeof authorizationHeader !== "string") return false;
    const prefix = "Bearer ";
    if (!authorizationHeader.startsWith(prefix)) return false;
    const provided = Buffer.from(authorizationHeader.slice(prefix.length));
    // Length check first: timingSafeEqual throws on unequal-length buffers, and
    // the comparison itself stays constant-time to avoid leaking the token.
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };
}
