/**
 * T4b (DEV-848): hosted HTTP path, no grant table.
 *
 * A bearer token with no auth.grants entry and no `sites` claim must not
 * reach every configured site. After token verification, grant/sites
 * resolution is deny-by-default: the principal is entitled to no sites,
 * so tools/call is refused with a closed denial (no site names) and
 * Cu(A) = Cu(B) = 0.
 *
 * Mutant (dependency swap): restore the pre-DEV-848 fall-through so a
 * token with no grant and no sites claim is entitled to every site.
 */

import { defineCase } from "../harness/case.js";
import { expectEqual, expectToolDenied } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T4b",
  title: "token with no grant entry and no sites claim reaches no site",
  harness: { grants: null },
  mutants: [
    { id: "T4b", expectedLabel: "tools/call without grant or sites claim: isError" },
  ],
  async run(h) {
    const token = await h.issuer.mint({
      sub: "ungranted-subject",
      azp: "client-ungranted",
      scope: "mcp_connect mcp_read",
      jti: "eval-t4b-1",
    });

    const list = await h.send(modernPost("tools/list"), { token });
    expectEqual(h, "tools/list status", list.status, 200);
    expectEqual(
      h,
      "tools/list is empty without a grant or sites claim",
      JSON.parse(list.text).result.tools.map((tool) => tool.name),
      [],
    );

    const call = await h.send(modernPost(
      "tools/call",
      { name: "drupal_list_nodes", arguments: {} },
      { name: "drupal_list_nodes" },
    ), { token });
    expectToolDenied(h, "tools/call without grant or sites claim", call);

    expectEqual(h, "Cu(A)", h.fake.count("A"), 0);
    expectEqual(h, "Cu(B)", h.fake.count("B"), 0);
    expectEqual(h, "Ct: tool body not executed", h.counters.ct, 0);

    const found = h.tap.scan(h.fake.canaries);
    expectEqual(h, "no canary A", found.A, 0);
    expectEqual(h, "no canary B", found.B, 0);
  },
});
