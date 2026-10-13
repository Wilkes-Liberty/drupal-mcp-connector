/**
 * T7: the allow twin of T1. Same builders, one input changed: a valid token.
 *
 * Increment 2 (a-3): every T1 shape has a twin. Outcomes are the
 * protocol-correct authenticated result, not "always 200":
 *   resources/list, prompts/list, initialize, tools/* → 200
 *   sessionless legacy ping / notification → 400 (not an auth error)
 *   empty body → 400 (malformed JSON, not an auth error)
 *   GET/DELETE without a session → 405
 *   GET/DELETE with a session id that was never issued → 404 after auth
 *
 * Mutant: an authenticator that rejects everything (over-blocking check).
 */

import { defineCase } from "../harness/case.js";
import { expectAllowed, expectEqual } from "../harness/assert.js";
import { UNAUTHENTICATED_LABELS } from "../harness/labels.js";
import { unauthenticatedRequests } from "../harness/requests.js";

const toolNames = (res) => JSON.parse(res.text).result.tools.map((tool) => tool.name);

const TWIN_STATUS = {
  "POST initialize": 200,
  "POST server/discover": 200,
  "POST tools/list": 200,
  "POST tools/call": 200,
  "POST resources/list": 200,
  "POST prompts/list": 200,
  "POST ping": 400,
  "POST notification": 400,
  "POST empty body": 400,
  "GET without session": 405,
  "GET with session": 404,
  "DELETE without session": 405,
  "DELETE with session": 404,
};

if (JSON.stringify(Object.keys(TWIN_STATUS)) !== JSON.stringify([...UNAUTHENTICATED_LABELS])) {
  throw new Error("T7 twins drifted from UNAUTHENTICATED_LABELS / manifest.requestLabels");
}

defineCase({
  id: "T7",
  title: "allow twin: a valid token on its own site is served",
  mutants: [
    { id: "T7", expectedLabel: "POST initialize: status" },
  ],
  async run(h) {
    const token = await h.tokenFor("A");
    const requests = unauthenticatedRequests();
    for (const [label, request] of requests) {
      const res = await h.send(request, { token });
      expectAllowed(h, label, res, { status: TWIN_STATUS[label] });
    }

    const list = h.tap.responses.find((_, index) => requests[index][0] === "POST tools/list")
      ?? h.tap.responses[2];
    expectEqual(h, "tools/list equals the entitlement", toolNames(list), ["drupal_list_nodes"]);

    expectEqual(h, "Cu(own)", h.fake.count("A"), 1);
    expectEqual(h, "Cu(other)", h.fake.count("B"), 0);
    expectEqual(h, "Ct: one tool body", h.counters.ct, 1);

    const found = h.tap.scan(h.fake.canaries);
    expectEqual(h, "own canary present in the output", found.A >= 1, true);
    expectEqual(h, "no foreign canary", found.B, 0);
  },
});
