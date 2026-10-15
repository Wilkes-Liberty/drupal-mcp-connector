/**
 * T2s: a token missing the required transport scope is 403 before
 * dispatch. Allow twin is T7 (`mcp_connect` present).
 *
 * Mutant: authenticator that accepts any bearer.
 */

import { defineCase } from "../harness/case.js";
import { expectHandlerUnreached, expectNoDispatch, expectRefused } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T2s",
  title: "insufficient-scope bearer is 403 before dispatch",
  mutants: [
    { id: "T2s", expectedLabel: "insufficient scope: status" },
  ],
  async run(h) {
    const token = await h.tokenFor("A", ["mcp_read"]);
    const res = await h.send(modernPost("tools/list"), { token });
    expectRefused(h, "insufficient scope", res, {
      status: 403,
      error: "insufficient_scope",
      description: "Required scope is missing",
      body: "Forbidden",
    });
    expectHandlerUnreached(h, "insufficient scope");
    expectNoDispatch(h, "insufficient scope");
  },
});
