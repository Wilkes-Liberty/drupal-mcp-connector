/**
 * T1 (DEV-866): POST /mcp with no Authorization, and GET/DELETE /mcp, against
 * the hosted configuration started through `startHttpsTransport`.
 *
 * Expected: 401; error="invalid_token", description "Bearer token required";
 * resource_metadata present; body "Unauthorized"; handler not reached;
 * Ch = Ct = Cu = 0; no Mcp-Session-Id issued; the request body is not read.
 *
 * Mutants:
 *   T1 — drop the authenticator (requests are served).
 *   T1-dispatch-before-auth (a-1) — dispatch, then still write 401. Killed
 *   only if the pack asserts the handler was not reached.
 */

import { expect } from "vitest";
import { defineCase } from "../harness/case.js";
import { expectEqual, expectHandlerUnreached, expectNoDispatch, expectRefused } from "../harness/assert.js";
import { UNAUTHENTICATED_LABELS } from "../harness/labels.js";
import { unauthenticatedRequests } from "../harness/requests.js";

const UNAUTHENTICATED = unauthenticatedRequests();

if (JSON.stringify(UNAUTHENTICATED.map(([label]) => label)) !== JSON.stringify([...UNAUTHENTICATED_LABELS])) {
  throw new Error("T1 request labels drifted from UNAUTHENTICATED_LABELS / manifest.requestLabels");
}

defineCase({
  id: "T1",
  title: "missing identity is refused with 401 before dispatch",
  mutants: [
    { id: "T1", expectedLabel: "POST initialize: status" },
    { id: "T1-dispatch-before-auth", expectedLabel: "POST initialize: handler was not reached" },
  ],
  async run(h) {
    for (const [label, request] of UNAUTHENTICATED) {
      const res = await h.send(request);
      expectRefused(h, label, res);
      expectHandlerUnreached(h, label);
      expectNoDispatch(h, label);
    }
    await h.waitServerSide(UNAUTHENTICATED.length);
    expectEqual(h, "body not read on any refusal", h.tap.serverSide.map((entry) => entry.bodyRead), UNAUTHENTICATED.map(() => false));
    expect(h.tap.serverSide).toHaveLength(UNAUTHENTICATED.length);
  },
});
