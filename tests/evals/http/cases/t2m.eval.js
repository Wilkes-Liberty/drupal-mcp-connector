/**
 * T2m: a verified token whose principal is not on the admission list
 * is 403 before dispatch. Allow twin is T7 (admitted principal).
 *
 * Mutant: authenticator that accepts any bearer (admission never runs).
 */

import { defineCase } from "../harness/case.js";
import { expectEqual, expectHandlerUnreached, expectNoDispatch } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T2m",
  title: "non-member bearer is 403 before dispatch",
  harness: {
    allowedPrincipals: [{ clientId: "client-a", sub: "client-a-subject" }],
  },
  mutants: [
    { id: "T2m", expectedLabel: "non-member: status" },
  ],
  async run(h) {
    const token = await h.tokenFor("B");
    const res = await h.send(modernPost("tools/list"), { token });
    expectEqual(h, "non-member: status", res.status, 403);
    expectEqual(h, "non-member: body", res.text, "Forbidden");
    expectEqual(
      h,
      "non-member: admitted description",
      String(res.headers["www-authenticate"] || "").includes("Principal is not admitted"),
      true,
    );
    expectHandlerUnreached(h, "non-member");
    expectNoDispatch(h, "non-member");
  },
});
