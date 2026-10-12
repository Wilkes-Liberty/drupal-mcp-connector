/**
 * T1n (DEV-845). Startup, not a request: resolve the inbound mode for a
 * non-loopback bind with MCP_ALLOW_UNAUTHENTICATED=1 and no resource server.
 *
 * Expected: fatal start with a named reason; no listener opens.
 * `resolveInboundAuthMode` is the decision src/index.js uses before listen
 * (`allowUnauth: true` when MCP_ALLOW_UNAUTHENTICATED === "1").
 *
 * Not covered: the note's second variant (a loopback bind with no token in a
 * hosted deployment). The connector has no hosted-profile switch to select
 * that deployment, and none is invented here.
 */

import { defineCase } from "../harness/case.js";
import { expectStartupFatal } from "../harness/assert.js";
import { inboundAuthModeForEval } from "../harness/build.js";

defineCase({
  id: "T1n",
  title: "non-loopback bind with MCP_ALLOW_UNAUTHENTICATED=1 is fatal at startup",
  needsHarness: false,
  async run(h) {
    const decision = inboundAuthModeForEval({
      bindHost: "0.0.0.0",
      allowUnauth: true,
      sharedToken: "",
      resourceServer: { issuer: "", audience: "" },
    }, h.mutant);
    expectStartupFatal(h, "non-loopback + allow-unauthenticated", decision);
  },
});
