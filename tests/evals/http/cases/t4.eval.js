/**
 * T4 (DEV-848): allow twin of T4b.
 *
 * A token with an explicit auth.grants entry for site A reaches A only,
 * never B. Same hosted HTTP path and tool as T4b; the single input that
 * changes is the grant table (client-a → site-a).
 *
 * Mutant (dependency swap): ignore grants and entitle every configured
 * site, so the call also reaches B.
 */

import { defineCase } from "../harness/case.js";
import { expectAllowed, expectEqual } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T4",
  title: "allow twin: an explicit grant for site A reaches A only, not B",
  mutants: [
    { id: "T4", expectedLabel: "Cu(B)" },
  ],
  async run(h) {
    const token = await h.tokenFor("A");
    const call = await h.send(modernPost(
      "tools/call",
      { name: "drupal_list_nodes", arguments: {} },
      { name: "drupal_list_nodes" },
    ), { token });
    expectAllowed(h, "tools/call", call);

    expectEqual(h, "Cu(A)", h.fake.count("A"), 1);
    expectEqual(h, "Cu(B)", h.fake.count("B"), 0);
    expectEqual(h, "Ct: one tool body", h.counters.ct, 1);

    const found = h.tap.scan(h.fake.canaries);
    expectEqual(h, "own canary present in the output", found.A >= 1, true);
    expectEqual(h, "no foreign canary", found.B, 0);
  },
});
