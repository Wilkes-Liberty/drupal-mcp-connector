/**
 * Optional bearer-token authentication for the HTTPS MCP transport.
 * makeBearerCheck(token) returns a predicate over the Authorization header.
 * A falsy token disables auth (predicate always true) — opt-in by design.
 */

import { timingSafeEqual } from "crypto";

export function makeBearerCheck(token) {
  if (!token) return () => true; // auth disabled
  const expected = Buffer.from(String(token));
  return (authorizationHeader) => {
    if (typeof authorizationHeader !== "string") return false;
    const prefix = "Bearer ";
    if (!authorizationHeader.startsWith(prefix)) return false;
    const provided = Buffer.from(authorizationHeader.slice(prefix.length));
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };
}
