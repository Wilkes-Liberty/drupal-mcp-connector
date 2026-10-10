/**
 * T1n (known red today, DEV-845). Startup, not a request: resolve the inbound
 * mode for a non-loopback bind with MCP_ALLOW_UNAUTHENTICATED=1 and no
 * resource server.
 *
 * Expected by the note: fatal start with a named reason; no listener opens.
 * Today `resolveInboundAuthMode` returns `unauthenticated`, so this case is
 * RED by design and is listed in known-red.json.
 *
 * `allowUnauth: true` is the value src/index.js passes when
 * MCP_ALLOW_UNAUTHENTICATED === "1" (index.js L274, L328).
 *
 * Not covered: the note's second variant (a loopback bind with no token in a
 * hosted deployment). The connector has no hosted-profile switch to select
 * that deployment, and none is invented here.
 */

import { defineCase } from "../harness/case.js";
import { expectStartupFatal } from "../harness/assert.js";
import { httpAuth } from "../harness/connector.js";

defineCase({
  id: "T1n",
  title: "non-loopback bind with MCP_ALLOW_UNAUTHENTICATED=1 is fatal at startup",
  needsHarness: false,
  async run(h) {
    const decision = httpAuth.resolveInboundAuthMode({
      bindHost: "0.0.0.0",
      allowUnauth: true,
      sharedToken: "",
      resourceServer: { issuer: "", audience: "" },
    });
    expectStartupFatal(h, "non-loopback + allow-unauthenticated", decision);
  },
});
