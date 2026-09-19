import { describe, it, expect } from "vitest";
import { httpStatusOf } from "../../src/lib/error-status.js";

describe("httpStatusOf", () => {
  it("reads the status property before the message", () => {
    const err = Object.assign(new Error("Drupal 404 on GET /jsonapi/x: gone"), { status: 500 });
    expect(httpStatusOf(err)).toBe(500);
  });

  it("ignores a status property that is not an HTTP status", () => {
    for (const status of ["404", 0, 99, 600, 404.5, NaN, null, true, {}]) {
      expect(httpStatusOf(Object.assign(new Error("boom"), { status }))).toBe(null);
    }
  });

  it("falls back to the status token at the start of a documented message", () => {
    expect(httpStatusOf(new Error("Drupal 404 on GET /jsonapi/node/page/n1: Not Found"))).toBe(404);
    expect(httpStatusOf(new Error("Drupal 403: No pending revision"))).toBe(403);
    expect(httpStatusOf(new Error("GraphQL request failed 401: Unauthorized"))).toBe(401);
    expect(httpStatusOf(new Error("File upload failed 422: bad extension"))).toBe(422);
    expect(httpStatusOf("Drupal 405 on PATCH /jsonapi/x")).toBe(405);
  });

  it("does not read a status from anywhere else in the text", () => {
    for (const message of [
      "Upstream answered 404 for the media source.",
      "lookup failed: Drupal 404 on GET /jsonapi/x",
      "Drupal 4040 on GET /x",
      "Drupal 404x",
      "the GraphQL request failed 401",
      "",
    ]) {
      expect(httpStatusOf(new Error(message))).toBe(null);
    }
    for (const value of [undefined, null, 404, {}]) expect(httpStatusOf(value)).toBe(null);
  });

  it("does not let a status token in the detail override the prefix", () => {
    expect(httpStatusOf(new Error("Drupal 500 on GET /jsonapi/x: Drupal 404 on GET /jsonapi/y"))).toBe(500);
  });
});
