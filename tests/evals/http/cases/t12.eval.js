/**
 * T12 (DEV-840): authenticated sessionless GET/DELETE `/mcp` are 405.
 * Allow twin: T7's GET/DELETE without session (same 405) and T7's session
 * DELETE after initialize.
 *
 * Mutant: sessionlessMethodRefusedFn always false, so the 405 is skipped.
 */

import { defineCase } from "../harness/case.js";
import { expectHandlerUnreached, expectNoDispatch, expectTransportDenied } from "../harness/assert.js";
import { sessionRequest } from "../harness/requests.js";

defineCase({
  id: "T12",
  title: "authenticated sessionless GET/DELETE are 405 before dispatch",
  mutants: [
    { id: "T12", expectedLabel: "GET without session: handler was not reached" },
  ],
  async run(h) {
    const token = await h.tokenFor("A");
    for (const method of ["GET", "DELETE"]) {
      const label = `${method} without session`;
      const res = await h.send(sessionRequest(method), { token });
      expectTransportDenied(h, label, res, { status: 405 });
      expectHandlerUnreached(h, label);
      expectNoDispatch(h, label);
    }
  },
});
