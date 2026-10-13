/**
 * T13 (DEV-840): a present Accept that lists neither JSON nor SSE is 406.
 * Allow twin: T7's tools/list (valid Accept).
 *
 * Mutant: acceptOkFn always true, so the request is served.
 */

import { defineCase } from "../harness/case.js";
import { expectHandlerUnreached, expectNoDispatch, expectTransportDenied } from "../harness/assert.js";
import { badAcceptPost } from "../harness/requests.js";

defineCase({
  id: "T13",
  title: "Accept listing neither JSON nor SSE is 406 before dispatch",
  mutants: [
    { id: "T13", expectedLabel: "bad Accept: status" },
  ],
  async run(h) {
    const token = await h.tokenFor("A");
    const res = await h.send(badAcceptPost(), { token });
    expectTransportDenied(h, "bad Accept", res, { status: 406 });
    expectHandlerUnreached(h, "bad Accept");
    expectNoDispatch(h, "bad Accept");
  },
});
