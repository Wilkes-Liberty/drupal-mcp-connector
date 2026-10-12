/**
 * T10 (DEV-840): a 2025-era session issued to principal A cannot be reused
 * by principal B. Token validation still runs; the session id is not authority.
 *
 * Mutant: sessionPrincipalKeyFn returns a constant, so B rides A's session.
 */

import { defineCase } from "../harness/case.js";
import { expectAllowed, expectEqual, expectTransportDenied } from "../harness/assert.js";
import { legacyInitialize, legacyPost } from "../harness/requests.js";

defineCase({
  id: "T10",
  title: "cross-principal session reuse is refused",
  async run(h) {
    const tokenA = await h.tokenFor("A");
    const tokenB = await h.tokenFor("B");

    const init = await h.send(legacyInitialize(), { token: tokenA });
    expectAllowed(h, "A initialize", init);
    const sessionId = init.headers["mcp-session-id"];
    expectEqual(h, "A was issued a session", typeof sessionId, "string");

    const hijack = await h.send(
      legacyPost("tools/list", {}, { id: 2, sessionId }),
      { token: tokenB },
    );
    expectTransportDenied(h, "B riding A's session", hijack, { status: 403 });
    expectEqual(h, "only initialize dispatched", h.counters.ch, 1);
    expectEqual(h, "no tool body on hijack", h.counters.ct, 0);
  },
});
