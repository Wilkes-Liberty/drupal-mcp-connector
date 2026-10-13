/**
 * T12 (DEV-862): a tool with no scope-table entry is not listed and not
 * callable on the hosted HTTP path. Zero upstream calls.
 *
 * Mutant: restore the v3.2.x default so an unknown name is treated as
 * mcp_read (listed and callable). The list/call assertions then fail.
 */

import { defineCase } from "../harness/case.js";
import { expectAllowed, expectEqual, expectToolDenied } from "../harness/assert.js";
import { modernPost } from "../harness/requests.js";

defineCase({
  id: "T12",
  title: "unscoped tool is absent from tools/list and refused on tools/call",
  async run(h) {
    const token = await h.tokenFor("A");
    const listed = await h.send(modernPost("tools/list"), { token });
    expectAllowed(h, "tools/list", listed);
    const names = JSON.parse(listed.text).result.tools.map((tool) => tool.name);
    expectEqual(h, "unscoped tool absent from tools/list", names.includes("drupal_eval_unscoped"), false);
    expectEqual(h, "known read tool still listed", names.includes("drupal_list_nodes"), true);

    const call = await h.send(modernPost(
      "tools/call",
      { name: "drupal_eval_unscoped", arguments: {} },
      { name: "drupal_eval_unscoped" },
    ), { token });
    expectToolDenied(h, "unscoped tools/call", call, { message: /scope table|requiredScopes/i });
    expectEqual(h, "Ct: tool body not executed", h.counters.ct, 0);
    expectEqual(h, "Cu: no upstream", h.fake.count(), 0);
  },
});
