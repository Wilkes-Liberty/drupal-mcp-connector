/**
 * T11 (DEV-840): a valid token with a disallowed Origin is 403 before dispatch.
 *
 * DNS-rebinding protection from Streamable HTTP 2026-07-28. Missing Origin
 * is still allowed (non-browser clients). Auth has already succeeded.
 *
 * Mutant: originAllowedFn always returns true, so the request is served.
 */

import { defineCase } from "../harness/case.js";
import { expectNoDispatch, expectTransportDenied } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T11",
  title: "disallowed Origin is 403 before dispatch",
  mutants: [
    { id: "T11", expectedLabel: "disallowed Origin: status" },
  ],
  async run(h) {
    const token = await h.tokenFor("A");
    const request = modernPost("tools/list");
    request.headers.origin = "https://evil.example";
    const res = await h.send(request, { token });
    expectTransportDenied(h, "disallowed Origin", res, { status: 403 });
    expectNoDispatch(h, "disallowed Origin");
  },
});
