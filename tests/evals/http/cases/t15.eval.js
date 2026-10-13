/**
 * T15 (DEV-860): per-principal rate limit on standalone /mcp.
 *
 * Two verified principals from the same client address: the first exceeds
 * its window and is 429 + Retry-After with no tool data; the second is
 * unaffected. A missing-token request under the address limit still uses
 * the shared 401 writer (DEV-845 / DEV-877).
 *
 * Mutant (dependency swap): `principalRateKeyFn` always returns null, so
 * the post-auth gate falls back to the address key. Both principals then
 * share one bucket and the second principal is 429 — the case goes red.
 */

import { defineCase } from "../harness/case.js";
import { expectAllowed, expectEqual, expectRefused } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T15",
  title: "authenticated /mcp is limited per verified principal, not per socket address",
  harness: {
    rateLimit: 1,
    principalRateLimit: 1,
  },
  mutants: [
    { id: "T15", expectedLabel: "principal B from the same IP: status" },
  ],
  async run(h) {
    const tokenA = await h.tokenFor("A");
    const tokenB = await h.tokenFor("B");

    const first = await h.send(modernPost("server/discover"), { token: tokenA, requestId: "t15-a1" });
    expectAllowed(h, "principal A under limit", first);

    const limited = await h.send(modernPost("server/discover"), { token: tokenA, requestId: "t15-a2" });
    expectEqual(h, "principal A over limit", limited.status, 429);
    expectEqual(h, "Retry-After present", Number(limited.headers["retry-after"]) > 0, true);
    expectEqual(h, "429 body has no tool data", limited.text, "Too Many Requests");
    expectEqual(h, "429 does not name tools", /drupal_|tools/i.test(limited.text), false);

    const other = await h.send(modernPost("server/discover"), { token: tokenB, requestId: "t15-b1" });
    expectAllowed(h, "principal B from the same IP", other);

    const missing = await h.send(modernPost("tools/list"), { requestId: "t15-missing" });
    expectRefused(h, "missing token under address limit", missing);
  },
});
