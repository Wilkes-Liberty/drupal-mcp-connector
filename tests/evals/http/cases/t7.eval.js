/**
 * T7 (DEV-866 increment 1): the allow twin of T1.
 *
 * One legitimate request per T1 deny case, built from the same builders with
 * one input changed: a valid token (own site, in-scope read tool). Covers
 * tools/list, an initialize (modern server/discover and legacy initialize),
 * and a tools/call.
 *
 * Expected: 200. tools/list equals the entitlement exactly. Ch = 1 per
 * request, Cu(own) = 1. The own canary is present in the output at least once.
 * No foreign canary.
 *
 * Mutant (dependency swap): an authenticator that rejects everything. This is
 * the over-blocking check: without it, a pack that blocks all traffic passes.
 */

import { defineCase } from "../harness/case.js";
import { expectAllowed, expectEqual } from "../harness/assert.js";
import { legacyInitialize, modernPost, sessionRequest } from "../harness/requests.js";

const toolNames = (res) => JSON.parse(res.text).result.tools.map((tool) => tool.name);

defineCase({
  id: "T7",
  title: "allow twin: a valid token on its own site is served",
  async run(h) {
    const token = await h.tokenFor("A"); // scopes: mcp_connect, mcp_read
    let sent = 0;
    const send = async (request) => {
      sent += 1;
      return h.send(request, { token });
    };

    const discover = await send(modernPost("server/discover"));
    expectAllowed(h, "server/discover", discover);

    const list = await send(modernPost("tools/list"));
    expectAllowed(h, "tools/list", list);
    // Entitlement: transport scope + mcp_read on site-a => the read tool only.
    expectEqual(h, "tools/list equals the entitlement", toolNames(list), ["drupal_list_nodes"]);

    const call = await send(modernPost("tools/call",
      { name: "drupal_list_nodes", arguments: {} }, { name: "drupal_list_nodes" }));
    expectAllowed(h, "tools/call", call);

    const init = await send(legacyInitialize());
    expectAllowed(h, "legacy initialize", init);
    const sessionId = init.headers["mcp-session-id"];
    expectEqual(h, "legacy initialize issues a session", typeof sessionId, "string");
    const close = await send(sessionRequest("DELETE", { sessionId }));
    expectAllowed(h, "DELETE own session", close);

    // One dispatch per request, one tool body, one upstream request, own site only.
    expectEqual(h, "Ch: one dispatch per request", h.counters.ch, sent);
    expectEqual(h, "Ct: one tool body", h.counters.ct, 1);
    expectEqual(h, "Cu(own)", h.fake.count("A"), 1);
    expectEqual(h, "Cu(other)", h.fake.count("B"), 0);

    const found = h.tap.scan(h.fake.canaries);
    expectEqual(h, "own canary present in the output", found.A >= 1, true);
    expectEqual(h, "no foreign canary", found.B, 0);
  },
});
