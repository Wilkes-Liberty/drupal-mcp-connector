/**
 * X1 (DEV-866 increment 3).
 *
 * Every live HTTP route and tool — from allDefinitions and the transport
 * route tables, never a hand-copied list — reaches dispatch only after
 * authn and authz. Production startup options are imported and inspected
 * (the residual asked for an import / runtime-spy pin, not source-text).
 *
 * Mutants (all must be killed on the pinned label):
 *   X1-public-all — treat every route as public.
 *   X1-open-tools — drop the network surface so a missing identity is local.
 *   X1-seams — inject checkAuth into production startup options.
 */

import { defineCase } from "../harness/case.js";
import { expectAllowed, expectEqual, expectHandlerUnreached, expectRefused } from "../harness/assert.js";
import { httpHandler } from "../harness/connector.js";
import { liveRoutes, liveTools } from "../harness/coverage.js";
import {
  SCANNER_OPEN_TOOLS,
  SCANNER_PUBLIC_ALL,
  SCANNER_SEAMS,
  assertLiveRoutesAuthn,
  assertLiveToolsAuthz,
  assertProductionSeams,
  splitRoute,
} from "../harness/scanner.js";

const firstTool = liveTools()[0];
const firstAuthRoute = liveRoutes().find((route) => {
  const { method, path } = splitRoute(route);
  return !httpHandler.isUnauthenticatedRoute(method, path);
});

defineCase({
  id: "X1",
  title: "live routes and tools reach dispatch only after authn and authz",
  harness: { edge: true },
  mutants: [
    { id: SCANNER_PUBLIC_ALL, expectedLabel: `X1: ${firstAuthRoute} unauthenticated: status` },
    { id: SCANNER_OPEN_TOOLS, expectedLabel: `X1: tool ${firstTool} denied without identity` },
    { id: SCANNER_SEAMS, expectedLabel: "X1: production startup omits eval seams" },
  ],
  async run(h) {
    assertProductionSeams(h, expectEqual);
    assertLiveToolsAuthz(h, expectEqual);
    await assertLiveRoutesAuthn(h, expectRefused, expectAllowed, expectHandlerUnreached);
  },
});
