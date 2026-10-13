/**
 * T18 (DEV-861): a Host that is not on the allowlist is 403 after auth,
 * with no dispatch. An unauthenticated request with a bad Host is still
 * the shared 401 + resource_metadata (DEV-845 / DEV-877). A good Host
 * (loopback, derived for this listener) is served.
 *
 * Mutant: hostAllowedFn always returns true, so the bad Host is served.
 */

import { defineCase } from "../harness/case.js";
import {
  expectAllowed,
  expectNoDispatch,
  expectRefused,
  expectTransportDenied,
} from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T18",
  title: "disallowed Host is 403 before dispatch; unauthenticated stays 401",
  mutants: [
    { id: "T18", expectedLabel: "disallowed Host: status" },
  ],
  async run(h) {
    const token = await h.tokenFor("A");
    const bad = await h.send(modernPost("tools/list"), {
      token,
      headers: { host: "evil.example" },
    });
    expectTransportDenied(h, "disallowed Host", bad, { status: 403 });
    expectNoDispatch(h, "disallowed Host");

    const unauth = await h.send(modernPost("tools/list"), {
      headers: { host: "evil.example" },
    });
    expectRefused(h, "unauthenticated bad Host", unauth);

    const good = await h.send(modernPost("tools/list"), { token });
    expectAllowed(h, "allowlisted Host", good);
  },
});
