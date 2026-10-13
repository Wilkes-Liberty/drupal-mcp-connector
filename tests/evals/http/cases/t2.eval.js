/**
 * T2: a present but invalid bearer is 401 before dispatch, with
 * resource_metadata. Allow twin is T7 (valid token).
 *
 * Mutant: authenticator that accepts any bearer, so a garbage token is served.
 */

import { defineCase } from "../harness/case.js";
import { expectHandlerUnreached, expectNoDispatch, expectRefused } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T2",
  title: "invalid bearer is 401 before dispatch",
  mutants: [
    { id: "T2", expectedLabel: "invalid token: status" },
  ],
  async run(h) {
    const res = await h.send(modernPost("tools/list"), { token: "not-a-jwt" });
    expectRefused(h, "invalid token", res, {
      error: "invalid_token",
      description: "Token is not active",
    });
    expectHandlerUnreached(h, "invalid token");
    expectNoDispatch(h, "invalid token");
  },
});
