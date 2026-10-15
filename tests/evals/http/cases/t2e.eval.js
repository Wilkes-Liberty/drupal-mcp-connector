/**
 * T2e: an expired bearer is 401 before dispatch. Allow twin is T7
 * (unexpired token). The fixture clock moves past the token lifetime
 * so Paladin is not involved.
 *
 * Mutant: authenticator that accepts any bearer.
 */

import { defineCase } from "../harness/case.js";
import { expectHandlerUnreached, expectNoDispatch, expectRefused } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T2e",
  title: "expired bearer is 401 before dispatch",
  mutants: [
    { id: "T2e", expectedLabel: "expired token: status" },
  ],
  async run(h) {
    const token = await h.tokenFor("A");
    h.clock.advance(400_000);
    const res = await h.send(modernPost("tools/list"), { token });
    expectRefused(h, "expired token", res, {
      error: "invalid_token",
      description: "Token has expired",
    });
    expectHandlerUnreached(h, "expired token");
    expectNoDispatch(h, "expired token");
  },
});
