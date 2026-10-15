/**
 * T2a: a verified issuer token with the wrong audience is 401 before
 * dispatch. Allow twin is T7 (correct audience).
 *
 * Mutant: authenticator that accepts any bearer.
 */

import { defineCase } from "../harness/case.js";
import { expectHandlerUnreached, expectNoDispatch, expectRefused } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T2a",
  title: "wrong-audience bearer is 401 before dispatch",
  mutants: [
    { id: "T2a", expectedLabel: "wrong audience: status" },
  ],
  async run(h) {
    const token = await h.issuer.mint({
      sub: "client-a-subject",
      azp: "client-a",
      scope: "mcp_connect mcp_read",
      jti: "eval-t2a-1",
      aud: "https://wrong.example/mcp",
    });
    const res = await h.send(modernPost("tools/list"), { token });
    expectRefused(h, "wrong audience", res, {
      error: "invalid_token",
      description: "Audience mismatch",
    });
    expectHandlerUnreached(h, "wrong audience");
    expectNoDispatch(h, "wrong audience");
  },
});
